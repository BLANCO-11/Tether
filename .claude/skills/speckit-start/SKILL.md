---
name: "speckit-start"
description: "Onboard a project by interviewing the user to establish four enforceable foundational standards — Constitution, Frameworks, Security, and (if the project has a UI) Design — before any feature code is written."
argument-hint: "Optional: a short description of the project"
compatibility: "Requires spec-kit project structure with .specify/ directory"
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
optional short description of the project; use it to inform your questions.

## Purpose

`/speckit-start` is the onboarding command for this template. It walks the user
through establishing four **project-level, enforceable** standards **before**
feature code exists:

1. **Constitution** — the project's governing principles.
2. **Frameworks** — the chosen tech stack, and whether the project has a UI.
3. **Security** — the security posture (required for **every** project).
4. **Design** — the UI/UX design system (**only when the project has a UI**).

The output is a set of standard files under `.specify/memory/` plus a
machine-readable manifest `.specify/memory/standards.json` that arms the
existence gate. Once established, source work is hard-blocked until the required
standards exist; conformance to their content is checked by `/speckit-comply`
and the pull-time review.

**This is an interview.** Ask focused questions, one topic at a time, attach
your best guess to each, and wait for the user. Do NOT auto-fill a standard
without the user's input for that step. Give every step full attention; the
Design step is the most iterative.

## Preconditions & resume behavior

1. Confirm you are in a spec-kit project (a `.specify/` directory exists).
2. Read `.specify/memory/standards.json` if present:
   - **absent** → this is a first run (or template-dev). Proceed; you will
     create it.
   - **`status: pending`** → onboarding was started (e.g. armed by `setup.sh`);
     continue and complete the missing steps.
   - **`status: established`** → standards already exist. Do **NOT** clobber
     them. Report what exists and tell the user that changes should go through
     `/speckit-update-standards`. Only continue for steps whose files are
     missing.
3. **Never overwrite** an existing standard file or history without the user's
   explicit confirmation. Report which standards are present vs missing before
   you begin.

Use the templates in `.specify/templates/` as the starting structure for each
standard: `constitution-template.md`, `frameworks-template.md`,
`security-template.md`, `design-template.md`, and
`standards-manifest.schema.json`.

## Step 1 — Constitution

Goal: produce/refresh `.specify/memory/constitution.md`.

- If a starter `constitution.md` already exists, read it and interview the user
  about which principles to keep, drop, or add rather than starting blank.
- Interview across: engineering principles, quality gates, review policy,
  branching/delivery, documentation expectations, and any non-negotiables.
- Preserve the existing NON-NEGOTIABLE articles (Spec-First; Secrets Hygiene)
  unless the user explicitly and knowingly changes them.
- Write the result via the constitution template, keeping the
  `**Version** | **Ratified** | **Last Amended**` footer current. (You may
  delegate the heavy lifting to `/speckit-constitution` if the user prefers.)

Confirm the constitution with the user before moving on.

## Step 2 — Frameworks (and UI determination)

Goal: produce `.specify/memory/frameworks.md` and decide `has_ui`.

- Ask what frameworks/stack the user intends. If they don't know, recommend a
  stack for their described project and explain the tradeoffs.
- **Determine `has_ui`** using this order:
  1. If the user states it explicitly, use that.
  2. Otherwise infer from the stack: a web/desktop/mobile UI framework
     (e.g. Next.js, React, Vue, Svelte, SwiftUI, Tauri, Electron, Flutter)
     ⇒ `has_ui = true`; a pure API/CLI/library/data stack ⇒ `has_ui = false`.
  3. If you cannot confidently infer, **ASK** — do not assume.
- Record the chosen frameworks, versions/rationale, and an explicit
  **"Has UI: yes/no + how decided"** statement in `frameworks.md` via the
  template.

Confirm frameworks + the UI determination with the user before moving on.

## Step 3 — Security (required for EVERY project)

Goal: produce `.specify/memory/security.md`.

- Interview across, at minimum: **authentication**, **authorization/access
  control**, **data protection** (in transit/at rest, PII, retention),
  **secrets management**, **input handling/common vulns**, **dependency/supply
  chain**, and **logging/audit/incident response**. Tailor threat notes to the
  chosen frameworks.
- **NON-NEGOTIABLE (constitution article VIII)**: never write real credentials.
  Record secret **names** (env vars / secret-store keys) only. If the user
  supplies a real secret value, refuse to store it and tell them to put it in
  `.env` (gitignored) with a placeholder in `.env.example`.
- Write `security.md` via the security template.

Confirm the security posture with the user before moving on. Security runs even
for backend-only / no-UI projects.

## Step 4 — Design (ONLY if `has_ui = true`)

Skip this step entirely when `has_ui = false`.

See the detailed workshop protocol below ("Design Workshop"). It produces
`.specify/memory/design.md` and scaffolds a framework-native component library.
Do **not** finalize `design.md` without the user's **explicit approval**.

## Finalize — write the manifest

After the applicable steps are complete and confirmed:

1. Write/update `.specify/memory/standards.json` conforming to
   `.specify/templates/standards-manifest.schema.json`:
   - `schema_version: 1`
   - `status: "established"`
   - `has_ui`: the boolean determined in Step 2 (must not be null now)
   - `standards`: a record for `constitution`, `frameworks`, `security`,
     `design`, each with its `path`, `required` (security/constitution/
     frameworks = true; design = `has_ui`), and `present` (does the file exist).
   - `frameworks`: the chosen frameworks (informational)
   - `revision: 1`, `created`: today's date (ask the user or use the known
     current date; do not fabricate), `history_log:
     ".specify/memory/standards-history.md"`.
2. Create an initial `.specify/memory/standards-history.md` with an "onboarding
   established standards" entry (date, revision 1).
3. Report a summary: which standards were created, `has_ui`, and that the
   existence gate is now armed. Remind the user that future changes go through
   `/speckit-update-standards`, and that feature work continues with
   `/speckit-specify`.

## Design Workshop (invoked from Step 4 when has_ui)

Offer the user **two modes**:

- **Option 1 — Full facilitated workshop**: interview the user in depth on
  design choices (brand feel, color, typography, density, layout, key screens,
  accessibility needs). Treat it as a design workshop.
- **Option 2 — Reference / vibe mode**: the user gives a reference (e.g. "make
  it look like <product>", "clean modern", "playful"). Research the reference's
  visual language, make explicit assumptions, and propose from there.

In **both** modes:

1. **Produce resizable static HTML/CSS mockups** (no framework, no build step)
   under `docs/design/mockups/` — enough to show the key screens/components and
   the token choices. Use a single CSS file with CSS custom properties for the
   tokens so the user can see the system, not just one screen.
2. **Verify responsiveness before asking for approval.** The mockups MUST be
   checked at mobile (~375px), tablet (~768px), and desktop (~1280px) widths
   with **no overlap, clipping, or horizontal overflow**. If the
   `browser-testing-with-devtools` skill / Chrome DevTools MCP is available,
   drive the browser at those widths and fix issues before showing the user;
   otherwise tell the user exactly how to open and resize the files and what to
   look for.
3. **Feedback → revise loop**: show the mockups, gather feedback, and revise.
   Do at least one revision round. Iterate until the user is satisfied.
4. **Require explicit approval.** Do not proceed to finalize on "sounds good" or
   silence — get an explicit yes. If approval is withheld, do NOT write
   `design.md`; the design gate stays active.
5. On approval:
   - Write `.specify/memory/design.md` from the design template, filling in the
     **approved design tokens** (color, typography, spacing, radius, elevation),
     responsive breakpoints/rules, layout, component inventory, and
     accessibility baseline. Record the mode used and any reference.
   - **Scaffold a framework-native component library** for the framework chosen
     in Step 2: a tokens module (the approved tokens as code) plus a small set
     of primitive components (e.g. Button, Input, Card, layout container) that
     consume those tokens. Place it at a conventional location for that
     framework and record the location in `design.md` §7. Keep it minimal — the
     goal is that future features compose from it rather than re-derive styling.

## Guardrails

- Writing under `.specify/**`, `docs/**`, and the skill dirs is always allowed;
  the standards live there so this command is not blocked by the gate.
- Never fabricate a date; use the known current date or ask.
- Never store real secret values anywhere (article VIII).
- Never mark `status: established` until the required standards for this project
  actually exist on disk (security always; design iff has_ui).
- Re-runs must be non-destructive: report and fill gaps, don't clobber.
