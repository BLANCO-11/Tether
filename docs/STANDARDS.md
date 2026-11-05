# Foundational Standards

This template enforces **four project-level standards** that are established
once, up front, by `/speckit-start` — before any feature code is written — and
then enforced for the life of the project. This is the same "you have to go
through the process" philosophy that already governs spec/plan/tasks, applied to
the decisions that agents most often get wrong: architecture principles, tech
stack, security, and UI/UX design.

## The four standards

| Standard | File | Required for | Established by |
|---|---|---|---|
| Constitution | `.specify/memory/constitution.md` | every project | `/speckit-start` (Step 1) |
| Frameworks | `.specify/memory/frameworks.md` | every project | `/speckit-start` (Step 2) |
| Security | `.specify/memory/security.md` | **every project** | `/speckit-start` (Step 3) |
| Design | `.specify/memory/design.md` | **UI projects only** | `/speckit-start` (Step 4) |

The machine-readable **manifest** `.specify/memory/standards.json` records the
arming state, whether the project has a UI (`has_ui`), and the path + required
flag for each standard. It is the decidable source of truth the pre-write gate
reads. See the schema at `.specify/templates/standards-manifest.schema.json`.

## Lifecycle

```text
clone template ──▶ bash setup.sh ──▶ manifest armed "pending"
                                         │  (source writes blocked)
                                         ▼
                                   /speckit-start
                                (interview: constitution,
                                 frameworks, security, design)
                                         │
                                         ▼
                                manifest "established"
                             (security[+design if UI] enforced)
                                         │
             ┌───────────────────────────┼───────────────────────────┐
             ▼                            ▼                           ▼
     build features            /speckit-update-standards       pull-time review
   (/speckit-specify …)      (amend + tracked history)      (post-merge/checkout)
```

## Enforcement model

Two complementary layers, matching the rest of the template:

1. **Existence gate (decidable, in the pre-write hook)** —
   `scripts/spec-gate-core.sh` reads the manifest and **hard-blocks source
   writes** when a required standard is missing:
   - manifest **absent** → standards gate inactive (template-dev / pre-setup);
     only the normal spec gate applies.
   - status **pending** → all source writes blocked ("run `/speckit-start`").
   - status **established** → `security.md` required always; `design.md` required
     only when `has_ui` is true. Missing → blocked, naming the standard.
   The gate never parses code or standard contents — existence only — and fails
   open on its own errors (never bricks the agent).

2. **Conformance (judgment, by the agent)** — whether a change actually honors
   the standards' *content* (design tokens, security posture) is checked by
   `/speckit-comply` and surfaced by the pull-time review. This is deliberately
   not done in bash.

## Amending standards

Use `/speckit-update-standards` to change a standard mid-project. It interviews
you about the change, updates only the relevant file(s), appends an entry to
`.specify/memory/standards-history.md`, and bumps `revision` / `last_amended` in
the manifest. It refuses amendments that would violate a non-negotiable
principle (e.g. hardcoding secrets, constitution article VIII).

## Continuous compliance on pull

`.githooks/post-merge` and `.githooks/post-checkout` run
`ci/check-standards-compliance.sh` over incoming changes and **report** findings
(read-only — they never block or revert a pull). Run `/speckit-comply` for the
full agent-driven conformance review.

## Design projects

For UI projects, the Design step runs a workshop (full facilitated, or
reference/vibe mode). It produces resizable static HTML/CSS mockups under
`docs/design/mockups/` that you open and resize to catch mobile breakage before
it is baked in, iterates with you, and — only on explicit approval — writes
`design.md` and scaffolds a framework-native component library carrying the
approved design tokens. Future UI composes from that library. See
`docs/design/README.md`.

## Template development

This template repo itself has **no `standards.json`**, so the standards gate is
inactive here — the template can be developed without self-blocking. Adopters
get the manifest armed to `pending` by `setup.sh`.
