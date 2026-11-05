# Feature Specification: The secret gate stops refusing templates, and stops taking minutes

**Feature Branch**: `20260828-125520-secret-scan-templates-and-speed`

**Created**: 2026-08-28

**Status**: Draft

**Input**: A `git push` was refused over `packages/client/.env.local.example` — a placeholder template already on the remote. Investigating that surfaced a second defect in the same two files, and then a third: the scanner needs **~90 seconds to check 265 lines**.

---

## Context: three defects in two files, all measured

`ci/secret-policy.sh` and `ci/check-secrets.sh` are Article VIII's enforcement.
Everything below was measured on 2026-08-28, not inferred.

### Defect 1 — a template is refused for its name

`is_forbidden_secret_file` exempts exactly three literal basenames and then
forbids everything else in the family:

```bash
.env.example | .env.sample | .env.template) return 1 ;;   # exempt
.env | .env.*)                              return 0 ;;   # forbidden
```

`.env.local.example` is a template by every reading — the policy's own message
says *"provide a placeholder in .env.example instead"* — but it is not one of the
three literals, so it falls through and is forbidden.

**Consequence, observed**: `git push` of any new branch is refused. The file is
**already on `origin/v1-alpha`**, matched **no** content pattern, and its nine
values are 2–24 characters (`AUTH_SECRET` 10, `LOCAL_ADMIN_PASSWORD` 10,
`PARENT_API_KEY` 14 — real ones are 32+). It is a confirmed false positive.

⚠ **And it recurs on every new branch**, because `.githooks/pre-push` scans
`merge-base(origin/main)..HEAD` for a new branch — here 66 commits and 606 files.

### Defect 2 — the two exemption lists disagree

The same three literals appear twice, matched two different ways:
`is_forbidden_secret_file` matches on **basename**; `is_secret_scan_exempt`
matches on **full path**. Measured behaviour:

| File | Name rule | Content scanned? |
| :--- | :--- | :--- |
| `.env.example` | allowed | **exempt** |
| `packages/mcp-bridge/.env.example` | allowed | **scanned** |
| `packages/client/.env.local.example` | **FORBIDDEN** | exempt |
| `.env`, `.env.local`, `packages/x/.env.production` | forbidden | exempt |

Rows 1 and 2 are the same kind of file treated differently. The comment above
`is_secret_scan_exempt` claims *".env* templates (placeholders by definition)"*
are exempt, which is true only at the repository root.

⚠ **This makes the obvious fix for Defect 1 dangerous.** Adding
`.env.local.example` to *both* lists would make it committable **and**
unscanned — a real key pasted there would be invisible. The two defects have to
be fixed together or the first fix opens a hole.

### Defect 3 — the scanner is ~500× slower than the work requires

`scan_line` spawns **two processes per pattern, per line**:

```bash
for pat in "${SECRET_CONTENT_PATTERNS[@]}"; do
    if printf '%s' "$line" | grep -Eq "$pat"; then
```

11 patterns × 265 added lines = **2,915 `grep` invocations**. Measured:

| Measurement | Result |
| :--- | :--- |
| 1000 shell builtins (no `exec`) | 72 ms → 0.07 ms each; the loop itself is free |
| 100 × `/usr/bin/true` | 6,239 ms → **62 ms per spawn** (normal: 1–3 ms) |
| 50 real diff lines through `scan_line` | 15.8 s → **~83 s for 265 lines** |
| The same 11 patterns, one pass over the same input | **159 ms** |

The amplifier is this workstation's EDR agent — Cisco Secure Endpoint
(`ampdaemon` 9.9%, `ampscansvc` 7.2%, the top two CPU consumers) inspects every
`exec`. Load average was 2.06, so this is `exec` cost and not contention.

⚠ **The cost is not confined to one laptop.** It is why the push scan takes ~12
minutes, why `/speckit-comply` exceeds a two-minute timeout, and it will hit any
CI runner with endpoint protection. It also has a behavioural cost, which is the
real reason this is in scope: **a commit that prints nothing for 90 seconds looks
broken.** It was reported as "stuck", interrupted twice, and diagnosed as a block
when it was not one. A gate people believe is hanging is a gate people bypass.

---

## User Scenarios & Testing *(mandatory)*

### User Story 1 — A placeholder template can be committed and pushed (Priority: P1)

A developer commits or pushes a branch containing an `.env` **template** — a file
whose whole purpose is to document variable names with no real values. The gate
allows it, whatever the middle segment of its name.

**Why this priority**: it is the defect that stopped work. Nothing can be pushed
from this lineage until it is fixed.

**Independent Test**: `git push` of the current branch completes. Directly:
`is_forbidden_secret_file "packages/client/.env.local.example"` returns false.

**Acceptance Scenarios**:

1. **Given** `packages/client/.env.local.example` in the outgoing commits, **When**
   the branch is pushed, **Then** the push is not refused for that file.
2. **Given** a file named `.env.local.example`, `.env.development.sample` or
   `.env.staging.template`, **When** the name rule is applied, **Then** it is
   allowed.
3. **Given** a file named `.env`, `.env.local`, `.env.production` or
   `.env.example.bak`, **When** the name rule is applied, **Then** it is **still
   forbidden**. Widening must not admit a real secrets file.
4. **Given** the same names at any depth, **When** the rule is applied, **Then**
   the verdict is identical to the root case.

---

### User Story 2 — A template is allowed into git but still checked (Priority: P1)

A template being committable does not make it unexamined. If someone pastes a real
credential into a `*.example` file, the content scan catches it.

**Why this priority**: also P1, and it is what makes Story 1 safe rather than
merely convenient. Shipping Story 1 alone converts a false positive into a blind
spot — a strictly worse trade, because a false positive is loud and a blind spot is
silent.

**Independent Test**: plant a value matching a content pattern in a `*.example`
file and require the scan to report it.

**Acceptance Scenarios**:

1. **Given** a real-looking credential in any `.env*` template at any depth,
   **When** the content scan runs, **Then** it is reported.
2. **Given** an obvious placeholder (`your-api-key`, `<...>`, `changeme`,
   `${VAR}`) in the same file, **When** the scan runs, **Then** it is **not**
   reported — the existing placeholder recogniser still applies.
3. **Given** `.env`, `.env.local` or any file that legitimately holds real local
   secrets, **When** the scan runs, **Then** its content is **not** scanned. Those
   files are the correct home for real values; the name rule keeps them out of git.
4. **Given** the scanner's own source files, **When** the scan runs, **Then** they
   remain content-exempt — they contain the patterns by definition.
5. **Given** any two files of the same kind at different depths, **When** the scan
   runs, **Then** they are treated identically.

---

### User Story 3 — The gate answers fast enough to be trusted (Priority: P2)

A developer commits and gets a verdict in about a second. A push scanning a large
range finishes in seconds rather than minutes.

**Why this priority**: P2 because no correctness claim depends on it — but it is
the reason this gate is being worked around rather than waited for, so it is not
cosmetic.

**Independent Test**: time the staged scan over the same 265-line diff, before and
after, on this workstation. The reduction must be at least 20×; the measured
headroom is ~500×.

**Acceptance Scenarios**:

1. **Given** a staged diff of ~265 added lines, **When** the scan runs, **Then** it
   completes in under 5 seconds.
2. **Given** any diff, **When** the scan runs, **Then** the number of processes it
   spawns does not grow with the number of lines scanned.
3. **Given** a diff containing a real credential, **When** the fast scan runs,
   **Then** it is reported **with the file it is in**, exactly as before.
4. **Given** the full push range (66 commits, 606 files), **When** the scan runs,
   **Then** it completes in under 60 seconds.
5. **Given** any input, **When** both the old and new implementations are run over
   it, **Then** they report the same set of files. Speed must not change verdicts.

---

### Edge Cases

- **A template with no values at all** (every assignment empty) — allowed, scanned,
  reports nothing. This is the current state of `.env.example`.
- **A line containing the delimiter** used to attribute matches to files — must not
  split a line's content into a wrong filename or lose the match.
- **A file whose name is exactly `.env.example` but which holds a real key** — must
  be reported. This is a behaviour **change**: it is content-exempt today.
- **A binary or very long line** in the diff — must not hang or crash the scan.
- **An empty diff** — exits clean, reports nothing, spawns nothing.
- **A filename containing spaces or non-ASCII** — attribution must survive it.
- **A diff where the same file appears twice** (rename plus edit) — no duplicate
  reports for one line.

---

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: An `.env`-family file whose basename ends in `.example`, `.sample` or
  `.template` MUST be allowed into git, regardless of any middle segment.
- **FR-002**: Every other `.env`-family name MUST remain forbidden, including
  `.env`, `.env.local`, `.env.production`, and names where a template suffix is not
  final (e.g. `.env.example.bak`).
- **FR-003**: Both rules MUST decide from the **basename**, so a file's verdict does
  not depend on its directory.
- **FR-004**: `.env` templates MUST be **content-scanned**. The name exemption
  MUST NOT be accompanied by a content exemption.
- **FR-005**: Files that legitimately hold real local secrets (`.env`, `.env.local`,
  and every other forbidden name) MUST remain content-exempt.
- **FR-006**: The scanner's own two source files MUST remain content-exempt.
- **FR-007**: The existing placeholder recogniser MUST continue to suppress obvious
  non-secrets, unchanged.
- **FR-008**: The number of processes the scan spawns MUST NOT grow with the number
  of lines scanned.
- **FR-009**: A report MUST still name the file the match was found in.
- **FR-010**: The new implementation MUST report the same set of files as the old one
  for any given input. This MUST be demonstrated, not asserted.
- **FR-011**: There MUST be a single definition of what a template name is. The
  three literals appear twice today; after this change the concept MUST have one
  home.
- **FR-012**: Every rule added or changed MUST have a test, and each test MUST be
  shown failing when its rule is removed.

### Key Entities

- **Template name** — an `.env`-family basename ending in a template suffix. One
  definition, consulted by both rules.
- **Name verdict** — may this file enter git at all. Independent of content.
- **Content verdict** — does this file's text contain something credential-shaped.
  Independent of the name verdict, and this feature's central correction: today the
  two are entangled, so allowing a name silently stops the content being read.

---

## Success Criteria *(mandatory)*

- **SC-001**: `git push` of a branch containing `packages/client/.env.local.example`
  is not refused for that file.
- **SC-002**: A real credential planted in any `.env*` template at any depth is
  reported. Demonstrated by planting one.
- **SC-003**: A real secrets file (`.env`, `.env.local`) is still refused entry to
  git at every depth.
- **SC-004**: The staged scan over ~265 added lines completes in under 5 seconds,
  down from a measured ~83.
- **SC-005**: The scan over the 66-commit push range completes in under 60 seconds,
  down from ~12 minutes.
- **SC-006**: Old and new implementations agree on every file in the push range.
- **SC-007**: Every new control is demonstrated failing at least once, and the
  demonstration is recorded.
- **SC-008**: No existing gate is weakened. Specifically, nothing that is refused
  today becomes allowed, except `.env*` templates by name.

---

## Assumptions

1. **A template's purpose is documentation, so its name should be recognised by
   shape rather than by an enumerated list.** The list has already failed once; a
   fourth reasonable name would fail again.
2. **Content-scanning templates is a net gain.** It is stricter than today for
   `.env.example`, and it is expected to be a no-op in practice — every value in
   that file is currently empty, and `packages/mcp-bridge/.env.example` is already
   scanned and passes. To be verified, not assumed.
3. **Correctness does not depend on the number of processes.** Matching 11 patterns
   in one pass is the same question asked once instead of 2,915 times.
4. **The EDR agent is not ours to change.** Asking for a scan exclusion may be
   worth doing separately, but the gate must be usable without it.
5. **`.env.example` at the repository root remains the documented placeholder home**
   referenced by six messages across `scripts/`, `ci/` and `.githooks/`. No message
   text needs to change.

---

## Dependencies

- Touches `ci/secret-policy.sh` and `ci/check-secrets.sh`, which are **enforcement
  machinery** — deliberately excluded from the spec gate's always-editable paths,
  which is why this is its own feature.
- Consumed by `.githooks/pre-commit`, `.githooks/pre-push`,
  `scripts/spec-gate-core.sh` and the CI pipeline. All four must keep working.
- ⚠ **Article VIII states the CI secret scan has no bypass.** This feature changes
  what that scan decides, so it is exactly the kind of change the constitution
  expects to be specified and reviewed rather than edited quietly.

---

## Out of Scope

- The `.githooks/pre-push` range choice — scanning `merge-base(main)..HEAD` for a new
  branch re-scans history already on the remote. Real, and a separate design question:
  the current behaviour deliberately catches history created before hooks existed.
- The content patterns themselves. Not added to, removed from, or reworded.
- The placeholder recogniser's own vocabulary.
- `packages/client/.env.local.example`'s contents. Verified clean; not edited.
- Any change to what `.env.example` documents, or to the 22 blanked values in it.
- Rewriting history. Nothing here requires it, and nothing found requires rotation.
