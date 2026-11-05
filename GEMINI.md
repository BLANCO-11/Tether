# Project Instructions for Gemini CLI

The canonical team rules live in [AGENTS.md](AGENTS.md) - read that file at
the start of every session and follow it. Note: in Gemini CLI the spec-kit
commands use dot separators: `/speckit.specify`, `/speckit.plan`,
`/speckit.tasks`, `/speckit.implement`, `/speckit.backfill`,
`/speckit.comply`.

Summary: all source changes go through the spec-kit workflow; uncovered
changes are regularized with `/speckit.backfill` and verified with
`/speckit.comply`; a BeforeTool hook denies source writes outside the
workflow - when denied, run the command the denial message names instead of
working around it.

**Foundational standards first**: a new project MUST run `/speckit.start` to
establish its standards (Constitution, Frameworks, Security, and Design if it
has a UI) before any source work; the pre-write hook blocks source writes until
the required standards exist. Change a standard via `/speckit.update-standards`.
At session start, read these if present and treat them as binding:
`.specify/memory/constitution.md`, `frameworks.md`, `security.md`, `design.md`
(UI only), and the `standards.json` manifest. See `docs/STANDARDS.md`.
