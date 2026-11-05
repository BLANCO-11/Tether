-- Legal demo schema — the THIRD domain (contract lifecycle & obligations).
--
-- Lives in its OWN database (`legal_demo`), for the same reason `hr_demo` and
-- `finance_demo` do: the credential registered as a datasource must reach only
-- the data that workspace declares. `legal_ro` can connect here and nowhere
-- else, and `seed-legal-db.ts` asserts that from `pg_catalog` rather than
-- trusting the grants it just issued.
--
-- ALL DATA IN THIS DATABASE IS SYNTHETIC. Counterparty and employee names are
-- invented; every email address is on an RFC 2606 reserved domain
-- (`acme-legal.example`, `*-bounce.example`, and the per-counterparty
-- `*.example` domains) which can never resolve or receive mail. Nothing here is
-- derived from a real company, a real person or a real contract.
--
-- ── ⚠ THE INVERTED BOUNDARY IS DELIBERATE AND LOAD-BEARING ───────────────────
--
-- `finance_demo` teaches: DUE TODAY IS NOT OVERDUE. Zero days past due is not
-- overdue, so an overdue report uses `>` and a `>=` chases a vendor on the day
-- payment is due.
--
-- This database teaches the OPPOSITE, and the disagreement is the whole point:
--
--     A NOTICE DEADLINE ON THE AS-OF DATE IS STILL ACTIONABLE.
--     It is the LAST DAY notice can be served, so it belongs in the report and
--     in the most urgent bucket. The window is INCLUSIVE: `<=`, not `<`.
--
-- A developer who internalised Finance's rule and carries `<` into a
-- notice-window query silently drops the one contract that could still have been
-- saved. Two datasets that disagree is the only arrangement in which the rule has
-- to be READ rather than remembered. Do not "make these consistent".
--
-- ── ⚠ THE AUTO-RENEW INVERSION ───────────────────────────────────────────────
--
-- One boolean turns one date calculation into two opposite actions with two
-- opposite recipients:
--
--   auto_renew = true   Missing the deadline LOCKS YOU IN for another term.
--                       Money leaves. The notice goes OUTWARD, to the
--                       counterparty, to stop the renewal.
--   auto_renew = false  Missing the deadline LETS THE CONTRACT LAPSE.
--                       Service stops. The warning goes INWARD, to the internal
--                       contract owner, so somebody can renew it.
--
-- Same arithmetic, opposite consequence, opposite audience. A flow that treats
-- the two the same serves a termination notice to a counterparty it meant to
-- renew with — and every step of it exits zero. No units check, no null check
-- and no green run catches that, which is why `legal-queries.ts` splits it into
-- TWO named queries rather than returning one result set with a flag to branch
-- on. A trap resolved in the catalogue is structurally unreachable.
--
-- ── THE OTHER TRAPS, IN THE COLUMNS THAT CARRY THEM ──────────────────────────
--
--  * contracts.notice_period_days      NULL → TWO-LEVEL fallback (see below)
--  * contracts.end_date                NULL → evergreen, has no renewal at all
--  * contracts.superseded_by_id        the successor holds the live dates
--  * contracts.value_cents             MINOR units (cents)
--  * contract_clauses.liability_cap_multiple  a MULTIPLE, not currency
--  * obligations.owner_email           NULL → falls back to the contract's owner
--  * obligations.status                NOT authoritative; completions are
--  * notice_log                        suppression must be DATE-BOUNDED

DROP TABLE IF EXISTS notice_log CASCADE;
DROP TABLE IF EXISTS obligation_completions CASCADE;
DROP TABLE IF EXISTS obligations CASCADE;
DROP TABLE IF EXISTS contract_clauses CASCADE;
DROP TABLE IF EXISTS contract_relationships CASCADE;
DROP TABLE IF EXISTS contracts CASCADE;
DROP TABLE IF EXISTS contract_types CASCADE;
DROP TABLE IF EXISTS counterparties CASCADE;
DROP TABLE IF EXISTS legal_entities CASCADE;
DROP TABLE IF EXISTS org_settings CASCADE;

CREATE TABLE org_settings (
  key           varchar(64)  PRIMARY KEY,
  value         varchar(128) NOT NULL,
  description   text
);
COMMENT ON TABLE org_settings IS 'Organisation-wide defaults. default_notice_period_days is the LAST resort in a two-level fallback (contract -> contract type -> here); a query that omits either hop silently drops the contracts that rely on it.';

CREATE TABLE legal_entities (
  id            integer      PRIMARY KEY,
  entity_code   varchar(16)  NOT NULL UNIQUE,
  name          varchar(128) NOT NULL,
  jurisdiction  varchar(64)  NOT NULL
);
COMMENT ON TABLE legal_entities IS 'Which of OUR entities is the contracting party. Two entities, so an entity-scoped report is possible and a report that forgets to scope is visibly wrong.';

CREATE TABLE counterparties (
  id                 integer      PRIMARY KEY,
  counterparty_code  varchar(16)  NOT NULL UNIQUE,
  name               varchar(128) NOT NULL,
  -- NULL for a counterparty with no notice address on record. Any automation
  -- that serves notice must handle this rather than sending to "None" and
  -- counting it as served.
  contact_email      varchar(128),
  country            varchar(64)  NOT NULL,
  -- ⚠ A SOFT reference to finance_demo.vendors.vendor_code, and there is
  -- DELIBERATELY NO FOREIGN KEY. The two tenants are two databases precisely so
  -- they cannot be joined. "Correlate the legal and financial view of one
  -- supplier" is a real request and the answer has to go THROUGH THE PRODUCT,
  -- not through SQL. Leaving the column here with this comment is more
  -- instructive than leaving it out.
  vendor_code        varchar(16),
  status             varchar(16)  NOT NULL DEFAULT 'active'  -- active | inactive
);
COMMENT ON TABLE counterparties IS 'External contracting parties. contact_email is NULL for one; one more is on a domain that always hard-bounces; one has ZERO live contracts (the empty-group case). vendor_code is a soft reference to finance_demo with no FK and must never gain one.';
COMMENT ON COLUMN counterparties.vendor_code IS 'Soft correlation to finance_demo.vendors.vendor_code. NOT a foreign key and never will be — the tenants are separate databases by design.';

CREATE TABLE contract_types (
  id                         integer     PRIMARY KEY,
  code                       varchar(16) NOT NULL UNIQUE,
  name                       varchar(64) NOT NULL,
  -- ⚠ THE MIDDLE HOP of the two-level notice fallback, and NULL for two of the
  -- six types on purpose. Resolution order is:
  --     contracts.notice_period_days
  --  -> contract_types.default_notice_period_days
  --  -> org_settings.default_notice_period_days
  -- At least one contract in this dataset needs BOTH hops — its own value is
  -- NULL and so is its type's — and it is the HIGHEST-VALUE contract in the
  -- database, chosen so that a single-level COALESCE loses the expensive one.
  default_notice_period_days integer,
  requires_dpa               boolean     NOT NULL DEFAULT false
);
COMMENT ON TABLE contract_types IS 'Contract taxonomy. default_notice_period_days is the MIDDLE level of a two-level fallback and is NULL for two types, which is what makes the second hop real rather than decorative.';

CREATE TABLE contracts (
  id                  integer      PRIMARY KEY,
  contract_code       varchar(24)  NOT NULL UNIQUE,
  title               varchar(160) NOT NULL,
  counterparty_id     integer      NOT NULL REFERENCES counterparties(id),
  legal_entity_id     integer      NOT NULL REFERENCES legal_entities(id),
  type_code           varchar(16)  NOT NULL REFERENCES contract_types(code),
  -- The INTERNAL owner. Never NULL: it is the fallback for an obligation with no
  -- owner of its own, and it is the recipient of a lapse warning.
  owner_email         varchar(128) NOT NULL,
  start_date          date         NOT NULL,
  -- ⚠ NULL = EVERGREEN (perpetual). There is no renewal date and no notice
  -- deadline, so the contract must be excluded from every deadline report BY AN
  -- EXPLICIT PREDICATE. NULL date arithmetic yields NULL, which sorts to the top
  -- of a "most urgent" list rather than dropping out of it.
  end_date            date,
  -- ⚠ See the auto-renew inversion in the file header. This one boolean decides
  -- both what happens on a missed deadline and who hears about it.
  auto_renew          boolean      NOT NULL,
  -- NULL when auto_renew is false — there is no next term to describe.
  renewal_term_months integer,
  -- ⚠ NULL means "resolve it": contract_types.default_notice_period_days, then
  -- org_settings.default_notice_period_days. Stored as NULL rather than as a
  -- copy of the default so the fallback is a real join, not a duplicate.
  notice_period_days  integer,
  -- MINOR UNITS (cents), like finance_demo's amount columns.
  value_cents         bigint       NOT NULL,
  currency            char(3)      NOT NULL DEFAULT 'USD',
  -- draft | active | expired | terminated | superseded
  --
  -- A `draft` contract has no signed_date and is NOT YET A CONTRACT: it must
  -- never appear in a deadline report.
  status              varchar(16)  NOT NULL DEFAULT 'draft',
  -- ⚠ Set on a contract that has been renewed or replaced. The SUCCESSOR holds
  -- the live dates; reporting on the superseded row chases a counterparty about
  -- a contract that no longer governs. Self-referencing, NULL at the head of
  -- every chain.
  --
  -- The negative control is a pair of contracts sharing a title prefix with
  -- DIFFERENT counterparties: a rule keyed on title finds a chain that is not
  -- there. Only this column establishes supersession.
  superseded_by_id    integer      REFERENCES contracts(id),
  -- NULL for a draft only.
  signed_date         date,
  governing_law       varchar(64)  NOT NULL
);
COMMENT ON TABLE contracts IS 'The agreements. end_date NULL is evergreen (no renewal, exclude explicitly). notice_period_days NULL resolves via contract_types then org_settings. superseded_by_id points at the row holding the live dates. value_cents is MINOR units. A draft has no signed_date and belongs in no deadline report.';
COMMENT ON COLUMN contracts.auto_renew IS 'true: a missed notice deadline locks in another term (notice goes OUTWARD to the counterparty). false: a missed deadline lets the contract lapse (warning goes INWARD to owner_email). Same arithmetic, opposite action, opposite recipient.';
COMMENT ON COLUMN contracts.end_date IS 'NULL means EVERGREEN — no renewal date exists. Exclude by explicit predicate; NULL arithmetic sorts it to the top of an urgency list.';
COMMENT ON COLUMN contracts.value_cents IS 'MINOR units (cents). Divide by 100 before it reaches a person.';
CREATE INDEX contracts_counterparty_idx ON contracts (counterparty_id);
CREATE INDEX contracts_end_date_idx     ON contracts (end_date);

CREATE TABLE contract_relationships (
  id                  integer     PRIMARY KEY,
  parent_contract_id  integer     NOT NULL REFERENCES contracts(id),
  child_contract_id   integer     NOT NULL REFERENCES contracts(id),
  -- amends | sow_under | dpa_for
  relationship        varchar(16) NOT NULL,
  UNIQUE (parent_contract_id, child_contract_id, relationship)
);
COMMENT ON TABLE contract_relationships IS 'Non-supersession links (an SOW under an MSA, a DPA for a SaaS agreement). Deliberately SEPARATE from contracts.superseded_by_id so one column does not carry two different meanings.';

CREATE TABLE contract_clauses (
  id                     integer      PRIMARY KEY,
  contract_id            integer      NOT NULL REFERENCES contracts(id),
  clause_type            varchar(40)  NOT NULL,
  is_non_standard        boolean      NOT NULL DEFAULT false,
  risk_rating            varchar(8)   NOT NULL,   -- low | medium | high
  -- ⚠ A MULTIPLE OF ANNUAL CONTRACT VALUE, NOT AN AMOUNT. 2.00 means "twice
  -- annual value", not $2.00. A report that renders this with a currency symbol
  -- is a units trap of a different kind from finance_demo's cents-versus-dollars
  -- one, which is why the column name and the query alias both carry the unit.
  -- NULL where the clause states no cap.
  liability_cap_multiple numeric(4,2),
  summary                varchar(256) NOT NULL
);
COMMENT ON TABLE contract_clauses IS 'Extracted clauses. ⚠ liability_cap_multiple is a MULTIPLE of annual value, not currency — 2.00 is twice annual value, not $2.00.';
COMMENT ON COLUMN contract_clauses.liability_cap_multiple IS 'A MULTIPLE of annual contract value. Never render with a currency symbol.';
CREATE INDEX contract_clauses_contract_idx ON contract_clauses (contract_id);

CREATE TABLE obligations (
  id              integer      PRIMARY KEY,
  obligation_code varchar(16)  NOT NULL UNIQUE,
  contract_id     integer      NOT NULL REFERENCES contracts(id),
  description     varchar(256) NOT NULL,
  -- report | payment | notice | audit | deletion
  obligation_type varchar(16)  NOT NULL,
  -- ⚠ NULL means "use the parent contract's owner_email". One obligation in this
  -- dataset relies on it; without the COALESCE the reminder goes to nobody, or
  -- to the string "None".
  owner_email     varchar(128),
  due_date        date         NOT NULL,
  recurrence      varchar(12)  NOT NULL DEFAULT 'none',  -- none | monthly | quarterly | annual
  -- open | complete | waived
  --
  -- ⚠ THIS COLUMN IS THE REGISTER'S OPINION AND IS NOT ALWAYS CURRENT. Exactly
  -- one obligation here has a row in `obligation_completions` and still reads
  -- `open`. Completion is computed from that table; `status` is not the truth.
  -- (Same lesson as finance_demo's fully-paid invoice that still reads `open`,
  -- in a different shape.)
  --
  -- `waived` is SETTLED. A waived obligation past its due date must never be
  -- chased, however overdue — the same rule as Finance's rejected claim, which
  -- was missed once already.
  status          varchar(12)  NOT NULL DEFAULT 'open',
  -- ⚠ There is deliberately no `overdue` status. Overdue is DERIVED from
  -- due_date against the as-of date. A stored flag would be a second answer that
  -- can disagree with the dates.
  notes           varchar(256)
);
COMMENT ON TABLE obligations IS 'Dated duties under a contract. owner_email NULL falls back to the contract owner. status is NOT authoritative — completion comes from obligation_completions. A waived obligation is settled and must never be chased. There is no stored overdue flag; overdue is derived.';
COMMENT ON COLUMN obligations.status IS 'open | complete | waived. NOT authoritative: one obligation has a completion row and still reads open. Compute completion from obligation_completions.';
CREATE INDEX obligations_due_date_idx ON obligations (due_date);
CREATE INDEX obligations_contract_idx ON obligations (contract_id);

CREATE TABLE obligation_completions (
  id            integer      PRIMARY KEY,
  obligation_id integer      NOT NULL REFERENCES obligations(id),
  completed_date date        NOT NULL,
  evidence_ref  varchar(32)  NOT NULL,
  completed_by  varchar(128) NOT NULL
);
COMMENT ON TABLE obligation_completions IS 'The evidence rows. THIS is the truth about whether an obligation is done — obligations.status lags it.';
CREATE INDEX obligation_completions_obligation_idx ON obligation_completions (obligation_id);

CREATE TABLE notice_log (
  id           integer      PRIMARY KEY,
  contract_id  integer      NOT NULL REFERENCES contracts(id),
  -- renewal_reminder | non_renewal | termination | lapse_warning
  notice_type  varchar(24)  NOT NULL,
  sent_date    date         NOT NULL,
  -- NULL where the send was attempted and there was no address to send to. An
  -- unserved LEGAL notice is not a failed email: the notice period never
  -- started. That is an escalation, not a logged warning.
  sent_to      varchar(128),
  channel      varchar(16)  NOT NULL   -- email | post | portal
);
COMMENT ON TABLE notice_log IS 'What was sent, to whom, when. The basis of ALREADY-NOTICED suppression, and the suppression must be DATE-BOUNDED: one contract here was noticed in the CURRENT window (suppress it) and one was noticed in a PRIOR renewal cycle (notify it again). An EXISTS with no date bound suppresses the wrong one and that contract auto-renews in silence.';
CREATE INDEX notice_log_contract_idx ON notice_log (contract_id);
