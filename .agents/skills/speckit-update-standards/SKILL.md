---
name: "speckit-update-standards"
description: "Amend an established project standard (constitution, frameworks, security, or design) mid-project: interview the user for the change, update only the relevant file(s), and record a tracked, auditable history entry."
argument-hint: "Optional: what you want to change (e.g. 'require MFA for admins')"
compatibility: "Requires spec-kit project structure with .specify/ directory and established standards"
metadata:
  author: "spec-kit-starter-template"
  source: "features/speckit-start-onboarding"
user-invocable: true
disable-model-invocation: false
---

## User Input

```text
$ARGUMENTS
```

You **MUST** consider the user input before proceeding (if not empty). It is an
optional description of the change the user wants.

## Purpose

`/speckit-update-standards` is the **governed path** for changing a project's
foundational standards after `/speckit-start` has established them. It interviews
the user about the desired change, updates only the relevant standard file(s),
records a tracked history entry, and bumps the manifest revision — never a silent
edit.

Use this instead of hand-editing `.specify/memory/*.md`. If standards have not
been established yet (`standards.json` absent or `status: pending`), tell the
user to run `/speckit-start` first.

## Steps

### 1. Load current state

- Read `.specify/memory/standards.json`. If it is absent or `status` is not
  `established`, STOP and direct the user to `/speckit-start`.
- Read the current standard files: `constitution.md`, `frameworks.md`,
  `security.md`, and `design.md` (if present). Read
  `.specify/memory/standards-history.md` if it exists.

### 2. Interview for the change

- Identify **which standard(s)** the change touches (constitution / frameworks /
  security / design). If unclear, ask.
- Interview for specifics: what exactly changes, and **why** (the rationale is
  recorded in history). Attach your best guess to each question and confirm.
- If the change affects the **UI determination** (e.g. adding a UI to a
  previously headless project, or removing it), plan to update both
  `frameworks.md` (the "Has UI" statement) and the manifest (`has_ui` +
  `standards.design.required`). If a UI is being added, the design standard now
  becomes required — run the Design Workshop (see `/speckit-start`) or tell the
  user to run `/speckit-start` to produce `design.md`.

### 3. Guardrails — refuse non-negotiable violations

Do NOT apply a change that would violate a non-negotiable principle. In
particular (constitution article VIII, NON-NEGOTIABLE): never introduce
hardcoded credentials, never weaken secrets hygiene to allow committing secrets,
and never remove a NON-NEGOTIABLE constitution article without the user
explicitly acknowledging the consequence. If the requested change conflicts,
**surface the conflict** and propose a compliant alternative rather than
applying it.

### 4. Apply the change

- Edit **only** the relevant standard file(s). Keep the change minimal and
  consistent with the file's structure/template.
- For a constitution change, update its version footer per its own semantic
  versioning policy (or delegate to `/speckit-constitution`).

### 5. Record history + bump the manifest

- Append an entry to `.specify/memory/standards-history.md` (create it if
  missing) using this shape:

  ```markdown
  ## <YYYY-MM-DD> — revision <N>

  - **Standard(s)**: <constitution|frameworks|security|design>
  - **Change**: <what changed, concisely>
  - **Why**: <rationale>
  ```

- Update `.specify/memory/standards.json`: increment `revision`, set
  `last_amended` to today's known date (do not fabricate), update any
  `standards.<key>.present`/`required` flags that changed, and update `has_ui`
  if the UI determination changed. Keep it valid against
  `.specify/templates/standards-manifest.schema.json`.

### 6. Report

Summarize: which standard(s) changed, the new revision, and the history entry.
Remind the user that `/speckit-comply` (and the pull-time review) will check
existing code against the amended standard, and that any now-non-conforming code
should be brought into line through the normal spec-kit workflow.

## Guardrails

- Writing under `.specify/**` and `docs/**` is always allowed (not gated).
- Never fabricate a date; use the known current date or ask.
- Never store real secret values (article VIII); record secret NAMES only.
- Update only what the user approved; do not opportunistically rewrite standards.
- One amendment = one history entry = one revision bump.
