# Frameworks Record

<!--
  Produced by /speckit-start (Frameworks step) and amended via
  /speckit-update-standards. Records the chosen technology frameworks and the
  UI determination that decides whether the Design step runs.

  The authoritative machine-readable UI flag lives in
  .specify/memory/standards.json (`has_ui`). This document explains the human
  reasoning behind it and must be kept in sync.
-->

**Project**: [PROJECT NAME]
**Established**: [DATE]
**Last amended**: [DATE]

## Chosen Frameworks

| Layer | Framework / Tool | Version | Rationale |
|-------|------------------|---------|-----------|
| [e.g. Frontend] | [e.g. Next.js] | [x.y] | [why] |
| [e.g. Backend] | [e.g. FastAPI] | [x.y] | [why] |
| [e.g. Data] | [e.g. PostgreSQL] | [x.y] | [why] |
| [e.g. Styling] | [e.g. Tailwind] | [x.y] | [why] |

## UI Determination

**Has UI: [yes | no]**

**How it was decided**: [user stated explicitly | inferred from framework —
e.g. "Next.js / Tauri implies a UI" | asked because no clear signal]

- If **yes** → the Design step runs and produces `design.md` + a component
  library; the design existence gate is active.
- If **no** → the Design step is skipped; `design.md` is not required.

## Framework-Specific Conventions

- [Project structure conventions, build/run commands, testing frameworks,
  linting/formatting, and any framework idioms new code must follow.]

## Notes

- Changing the UI determination later (e.g. adding a UI to a backend project)
  is done via `/speckit-update-standards`, which updates both this record and
  the `has_ui` flag + `design` requirement in `standards.json`.
