# Implementation Plan: The secret gate stops refusing templates, and stops taking minutes

**Feature**: `20260828-125520-secret-scan-templates-and-speed`
**Created**: 2026-08-28
**Spec**: [spec.md](./spec.md)

## Technical context

| | |
| :--- | :--- |
| Language | POSIX-ish bash (the existing files' idiom) |
| Files changed | `ci/secret-policy.sh`, `ci/check-secrets.sh` |
| New files | `ci/secret-policy.test.sh` (the controls) |
| Dependencies added | **none** — `grep`, `git` only, as today |
| Consumers that must keep working | `.githooks/pre-commit`, `.githooks/pre-push`, `scripts/spec-gate-core.sh`, CI |

## Constitution check

| Article | Status | Note |
| :--- | :--- | :--- |
| I — Spec-First | satisfied | This feature exists because `ci/` is not always-editable. |
| II — Test-First | satisfied | FR-012: every rule gets a test, each shown failing when its rule is removed. |
| IV — Simplicity | satisfied | Net effect is *fewer* definitions: one template concept instead of two lists. |
| V — Observability | satisfied | Reports keep naming the file (FR-009); the fast path must not lose attribution. |
| VIII — Secrets Hygiene | **strengthened** | Templates become content-scanned. Nothing that is refused today becomes allowed except template *names*. |

## Complexity tracking

One thing needs justifying: the fast path introduces a **delimiter** between a
file label and a line's text, which the per-line loop did not need. That is real
added complexity, accepted because it is the only way to keep per-file attribution
(FR-009) while spawning a constant number of processes (FR-008). It is bounded by
choosing a byte that cannot occur in the payload — see Decision 3.

---

## Decisions

### D-1 — Recognise a template by SUFFIX, not by an enumerated list

Replace the three literals with a suffix test on the basename:
`.env*` whose name ends in `.example` / `.sample` / `.template`.

**Why**: the list has already failed once, on a name nobody would call
controversial. A fourth plausible name (`.env.staging.template`) fails again.

**What it must not admit**: the suffix must be **final**. `.env.example.bak` ends
in `.bak` and stays forbidden. This is the property most likely to be broken by a
careless glob (`.env*example*` would admit `.env.example.bak.real`).

### D-2 — One definition, consulted twice (FR-011)

`is_template_env_file()` becomes the single home for the concept.
`is_forbidden_secret_file` calls it; `is_secret_scan_exempt` no longer needs the
literals at all (see D-4). Two copies of a list is how the basename/full-path
divergence survived unnoticed.

### D-3 — Both rules decide from the BASENAME (FR-003)

`is_secret_scan_exempt` currently matches `case "$1"` — a full path — so
`packages/mcp-bridge/.env.example` misses and the root one hits. A file's verdict
must not depend on its directory.

⚠ **The scanner's own two files stay matched on FULL PATH**, deliberately:
`ci/secret-policy.sh` is exempt, and a file named `secret-policy.sh` somewhere else
is not. Basename matching there would be a genuine widening.

### D-4 — Templates become CONTENT-SCANNED (FR-004)

Remove `.env.example | .env.sample | .env.template` from `is_secret_scan_exempt`
rather than extending it.

**Why this is the whole point.** Today, allowing a name also stops the content
being read. So the naive fix for Defect 1 — add the name to both lists — would make
`packages/client/.env.local.example` both committable and unexamined. A false
positive is loud and recoverable; a blind spot is silent. Given a choice between
them, take the loud one.

**Expected to be a no-op in practice**, and this is checkable rather than hoped:
`.env.example`'s values are all empty, and `packages/mcp-bridge/.env.example` is
already scanned today and passes. Task T-108 verifies it before the change ships.

⚠ **Forbidden files stay content-exempt** (FR-005). `.env` and `.env.local` are the
*correct* place for real secrets; scanning them produces noise for a file the name
rule already keeps out of git.

### D-5 — One `grep` pass, with attribution preserved

Build the candidate stream in pure bash (no subprocess per line), pipe it **once**
into `grep -E` with the 11 patterns joined by `|`, then apply
`is_placeholder_line` only to the lines that matched.

**Why the placeholder check can stay per-line**: it only runs on matches, and
matches are rare — normally zero. The pathology was running 11 greps on *every*
line, not on the few that hit.

**Delimiter**: prefix each candidate line with `<path>` and a byte that cannot
appear in the payload. `\x01` is the choice; a tab or `:` can occur in real content
and would mis-split a filename. Only the prefix before the **first** delimiter is
treated as the path.

⚠ **`grep -E` with a long alternation must be verified to behave identically** to
the 11 separate patterns. Alternation changes which branch matches first, and one
of the patterns is `[-]{5}BEGIN[ A-Z]*PRIVATE KEY` — written that way so the file
does not match itself. FR-010's equivalence run is what proves this, and it is
non-negotiable: this is the step where a speed change could silently become a
correctness change.

### D-6 — Old and new must be shown to agree (FR-010)

Keep the old per-line implementation available under a second name for the duration
of the verification, run both over the full 66-commit push range, and diff the
reported file sets. Then delete the old one.

**Why not just trust the tests**: the tests cover the cases we thought of. The push
range is 606 real files including every historical `.env`, key and certificate the
repository has ever seen — the best available corpus, and it costs one 12-minute run
once.

---

## Approach, in order

1. **Measure the baseline** so the improvement is a comparison rather than a claim.
2. **Verify D-4 is a no-op today** — scan both existing templates for content
   matches *before* removing their exemption. If either matches, that is a real
   finding to report, not a reason to abandon the change.
3. **Add the tests first** (Article II), including the negative cases that must stay
   forbidden.
4. **Land the name fix** (D-1, D-2, D-3) — this alone unblocks the push.
5. **Land the content-exemption fix** (D-4) in the same commit as the name fix.
   ⚠ **They must not be separated**: the window between them is exactly the blind
   spot described in D-4.
6. **Land the single-pass rewrite** (D-5) as its own commit, so a bisect can tell a
   correctness change from a speed change.
7. **Run the equivalence check** (D-6), record it, then remove the old implementation.
8. **Re-measure** and record both numbers.

## Risks

- ⚠ **The alternation rewrite is the risky half.** A pattern that behaves
  differently inside an alternation would quietly stop matching, and the symptom is
  a scan that passes. Mitigated by D-6's equivalence run over 606 real files, and by
  a planted-secret test that must fail if the fast path misses it.
- **Removing a content exemption could surface a real finding** in
  `.env.example`. That would be a genuine leak this feature discovered, and the
  response is to report and rotate — not to restore the exemption.
- **The `\x01` delimiter assumption**: if a diff line can contain `\x01`, attribution
  breaks. Bounded by a test that plants one.
- **No change to the pre-push range** (out of scope), so a new-branch push still
  re-scans history. After D-5 that is seconds rather than minutes, which is why the
  range question can wait.
