# Tasks: The secret gate stops refusing templates, and stops taking minutes

**Feature**: `20260828-125520-secret-scan-templates-and-speed`
**Spec**: [spec.md](./spec.md) · **Plan**: [plan.md](./plan.md)

Files in scope: `ci/secret-policy.sh`, `ci/check-secrets.sh`,
`ci/secret-policy.test.sh` (new).

---

## Phase 0 — Baseline and pre-checks

- [X] **T-101** Record the current staged-scan duration over a ~265-line diff, and
  the current push-range duration, into `measurements.txt`. Without this the
  improvement is a claim.
  - Files: `specs/20260828-125520-secret-scan-templates-and-speed/measurements.txt`
- [X] **T-102** Record the current name/content verdict table for the eight probe
  paths in spec.md's Defect 2 table, into `measurements.txt`. This is the
  before-state every later assertion is compared against.
- [X] **T-103** ⚠ **Verify D-4 is a no-op today**: scan `.env.example` and
  `packages/mcp-bridge/.env.example` for content-pattern matches *before* removing
  their exemption. Record the result. **A match here is a real finding to report and
  rotate, not a reason to keep the exemption** (plan.md Risks).
  - Files: `specs/20260828-125520-secret-scan-templates-and-speed/measurements.txt`

## Phase 1 — Tests first (Article II)

- [X] **T-104** Create `ci/secret-policy.test.sh` with a runner that reports
  pass/fail counts and exits non-zero on any failure.
  - Files: `ci/secret-policy.test.sh`
- [X] **T-105** Name-rule ALLOW cases (FR-001): `.env.example`, `.env.sample`,
  `.env.template`, `.env.local.example`, `.env.development.sample`,
  `.env.staging.template`, and each of those nested two directories deep (FR-003).
  - Files: `ci/secret-policy.test.sh`
- [X] **T-106** Name-rule FORBID cases (FR-002) — the half most likely to be broken
  by a careless glob: `.env`, `.env.local`, `.env.production`, `.env.example.bak`,
  `.env.template.local`, `.env.examples`, and each nested. Plus the non-`.env`
  forbidden families (`id_rsa`, `*.pem`, `credentials.json`) to prove the rewrite
  did not disturb them.
  - Files: `ci/secret-policy.test.sh`
- [X] **T-107** Content-exemption cases (FR-004, FR-005, FR-006): templates are
  **scanned** at any depth; `.env`/`.env.local` are **exempt**;
  `ci/secret-policy.sh` and `ci/check-secrets.sh` are **exempt**; a file named
  `secret-policy.sh` elsewhere is **scanned** (D-3's deliberate full-path match).
  - Files: `ci/secret-policy.test.sh`
- [X] **T-108** Planted-secret test (SC-002): a credential-shaped value in a
  `*.example` file at depth MUST be reported; an obvious placeholder in the same
  file MUST NOT be (FR-007).
  - Files: `ci/secret-policy.test.sh`
- [X] **T-109** Delimiter test (plan.md Risks): a diff line containing a literal
  `\x01`, and one containing tabs and `:`, must not corrupt file attribution.
  - Files: `ci/secret-policy.test.sh`
- [X] **T-110** Edge-case tests: empty diff; a filename with spaces and non-ASCII; a
  very long line; the same file appearing twice in one diff.
  - Files: `ci/secret-policy.test.sh`
- [X] **T-111** Run the suite and confirm the new tests **FAIL** against the current
  implementation. A suite that passes before the fix is testing nothing.

## Phase 2 — The correctness fix (T-112 and T-113 MUST land in ONE commit)

- [X] **T-112** Add `is_template_env_file()` as the single definition (D-1, D-2) and
  call it from `is_forbidden_secret_file`. Suffix must be **final**.
  - Files: `ci/secret-policy.sh`
- [X] **T-113** Make `is_secret_scan_exempt` decide `.env`-family membership from the
  **basename** (D-3) and **remove** the three template literals from it (D-4), so
  templates are content-scanned. Keep the scanner's own two files matched on full
  path.
  - Files: `ci/secret-policy.sh`
  - ⚠ **Must be the same commit as T-112.** Between the two, a template is both
    committable and unscanned — the blind spot this feature exists to avoid.
- [X] **T-114** Run the suite; every Phase-1 test now passes.
- [X] **T-115** ⚠ **Perturbation**: revert T-112, confirm the ALLOW tests go red;
  revert T-113, confirm the content-exemption tests go red. Restore. Record which
  tests fired.
  - Files: `specs/20260828-125520-secret-scan-templates-and-speed/measurements.txt`
- [X] **T-116** Confirm SC-001: the push is no longer refused for
  `packages/client/.env.local.example`.
  - **VERIFIED TWICE, 2026-08-29.** First by invoking `.githooks/pre-push` with
    the exact stdin git sends for a new branch (remote sha all-zeros, so the
    68-commit / 608-file range): **exit 0 in 4,489 ms**. Then for real:
    `git push --set-upstream` created the remote branch, **exit 0 in 8,172 ms**
    including network. Before this change the same push was refused over
    `packages/client/.env.local.example` after ~12 minutes of scanning.

## Phase 3 — The speed fix (separate commit, so bisect can tell them apart)

- [X] **T-117** Rewrite `check_diff` to build the candidate stream in pure bash and
  pipe it **once** into `grep -E` with the joined alternation (D-5). Keep
  `is_placeholder_line` per **match**, not per line.
  - Files: `ci/check-secrets.sh`
- [X] **T-118** Preserve per-file attribution through the `\x01` prefix; only the
  text before the **first** delimiter is the path (FR-009).
  - Files: `ci/check-secrets.sh`
- [X] **T-119** Apply the same single-pass treatment to the `stdin` mode, which
  `scripts/spec-gate-core.sh` calls on every agent file write — so an agent's writes
  stop paying the per-line cost too.
  - Files: `ci/check-secrets.sh`
- [X] **T-120** Run the full suite plus T-108's planted secret against the fast path.
  ⚠ The planted-secret test is the one that matters here: a fast scan that misses a
  real secret passes every timing assertion.

## Phase 4 — Equivalence, then removal

- [X] **T-121** ⚠ **Equivalence run (FR-010, SC-006)**: keep the old per-line
  implementation under a second name, run both over the full 66-commit / 606-file
  push range, and diff the reported file sets. They must be identical.
  - Files: `ci/check-secrets.sh`, `specs/…/measurements.txt`
- [X] **T-122** Record the equivalence result, then delete the old implementation.
  - ⚠ **Nothing to delete.** The old per-line `scan_line` was REPLACED in place
    rather than kept alongside, so there was never a second implementation in the
    tree. The old code used for comparison lived in `/tmp/oldscan/`, from
    `git show HEAD:`, and is not part of the repository.
- [X] **T-123** Re-measure staged and push-range durations; record before and after
  side by side (SC-004: under 5 s; SC-005: under 60 s).
  - Files: `specs/…/measurements.txt`

## Phase 5 — Consumers and documentation

- [X] **T-124** Verify all four consumers still behave: `pre-commit` blocks a planted
  secret and allows a clean commit; `pre-push` likewise; `spec-gate-core.sh`'s
  content check still denies a planted secret on a file write; `ci/check-secrets.sh
  staged|range|stdin` all still exit correctly.
- [X] **T-125** Confirm SC-008 by re-running T-102's verdict table and diffing
  against the baseline. **The only permitted difference is template names becoming
  allowed, and template content becoming scanned.** Any other change is a regression.
  - Files: `specs/…/measurements.txt`
- [X] **T-126** Update the comment above `is_secret_scan_exempt`, which currently
  claims `.env*` templates are exempt — after T-113 that is false, and it was only
  ever true at the repository root.
  - Files: `ci/secret-policy.sh`
- [X] **T-127** Add a line to `CLAUDE.md` recording that templates are committable
  **and** scanned, and that the scanner is single-pass — with the measured numbers,
  so the next person does not rediscover the 90-second commit.
  - Files: `CLAUDE.md`

## Phase 6 — Out of scope, recorded so it is not mistaken for done

- [ ] **T-128** ⚠ **NOT DOING**: the `.githooks/pre-push` range choice. A new-branch
  push still scans `merge-base(origin/main)..HEAD` — 66 commits already on the
  remote. Real, deliberate (it catches pre-hook history), and a separate design
  question. After Phase 3 it costs seconds, which is why it can wait.
- [ ] **T-129** ⚠ **NOT DOING**: asking for an EDR scan exclusion for this
  repository. It would help every tool here, but the gate must be usable without it,
  and it is not this repository's change to make.
