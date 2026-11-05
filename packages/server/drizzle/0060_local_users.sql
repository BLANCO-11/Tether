-- Local accounts — a username and password for a person with no AD identity.
--
-- ⚠ WHY THIS IS A TABLE AND NOT MORE ENVIRONMENT VARIABLES ────────────────────
--
-- `packages/client/src/auth.ts` has one credentials account, from
-- `LOCAL_ADMIN_EMAIL`/`LOCAL_ADMIN_PASSWORD`, compared with `!==` on a
-- plain-text value. It cannot grow: a second account means a second pair of
-- variables and a redeploy, and every holder of the file knows every password.
--
-- ⚠ NO ROLE COLUMN, DELIBERATELY. A local account is an identity and nothing
-- more. Workspace rights live in `workspace_members`, keyed on the subject this
-- table issues, so there is ONE place a person's rights are read from whether
-- they arrived through Entra or through here. A `role` column here would be a
-- second authority that can disagree with it.
--
-- ⚠ AND NO super_admin COLUMN. Platform rights stay in SUPER_ADMIN_EMAILS on
-- the server, so creating an account is not a privilege-escalation path — a
-- compromised admin session cannot mint itself a second platform admin. The
-- create path additionally REFUSES an email already on that allowlist, because
-- `config.isSuperAdmin` matches on email as well as subject and would otherwise
-- grant through the back door exactly what omitting the column excludes.
CREATE TABLE IF NOT EXISTS local_users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- ⚠ The sign-in name, stored lower-case and unique. Case-folded at the
  -- service, never by a functional index, so the value read back is the value
  -- compared — a citext-ish index plus a raw column is two spellings of one
  -- identity and the one that loses is whichever the login path uses.
  username varchar(128) NOT NULL UNIQUE,
  -- Display only. NOT a login identifier and NOT unique: two people can share
  -- a mailbox, and making it unique would refuse a legitimate second account.
  email varchar(320),
  name varchar(255),
  -- ⚠ scrypt, from node:crypto — no new dependency. Salt is per row and the
  -- parameters are stored WITH the hash (see `local-user.service.ts`), so a
  -- future cost increase can re-hash on next sign-in without a migration.
  password_hash text NOT NULL,
  -- ⚠ Deactivating rather than deleting. A deleted row frees its username for
  -- reuse, and `workspace_members` rows keyed on the old subject would then
  -- apply to a different person.
  is_active boolean NOT NULL DEFAULT true,
  -- The super admin who created it, by identity SUBJECT. Attribution, not a
  -- permission: nothing reads it to decide anything.
  created_by text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  -- Written by the verify path on a successful sign-in. Never a gate.
  last_sign_in_at timestamptz
);

CREATE INDEX IF NOT EXISTS local_users_active_idx ON local_users (is_active);
