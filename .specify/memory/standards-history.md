# Standards Amendment History

Append-only. Every amendment to a file under `.specify/memory/` gets an entry
here, newest last. Amend standards via `/speckit-update-standards`, never by
silent edit.

---

## Revision 1 — 2026-08-25 — onboarding established standards

**Command**: `/speckit-start`
**Scope**: retroactive onboarding of an **existing** codebase. Six programmes had
already shipped before the standards gate was armed.

| Standard | Action | Note |
|----------|--------|------|
| `constitution.md` | **kept, unmodified** | Already present at v1.1.0, ratified 2026-07-10, and already load-bearing — `CLAUDE.md` and the CA feature's spec both cite articles I and VIII by number. Amending it during onboarding would have rewritten a document the repository already argues from. |
| `frameworks.md` | **created** | Transcribed from `package.json` files, `infra/docker-compose.yml` and the pinned image tags. Nothing was chosen here; the stack was read. |
| `security.md` | **created** | Assembled from the implemented controls, their tests, and the recorded measurements. |
| `design.md` | **created** | Transcribed from `globals.css` and `tailwind.config.ts`. |

**`has_ui`: true** — inferred from the stack and confirmed on disk
(`packages/client` is a Next.js 14 App Router app, 18 pages, 17 UI primitives, a
tokenised Tailwind theme). No ambiguity, so nothing to ask.

### Deviations from the `/speckit-start` protocol, and why

1. **No design workshop was run.** The protocol's workshop exists to *choose* a
   design system before component code exists. Foundry's was chosen, argued and
   measured across two completed programmes (`ui-upgrade`, D-74…D-112, and the
   old-app reconciliation), with its mockups and revision record already in
   `docs/design/mockups/` and its contrast ratios computed rather than judged.
   Proposing fresh tokens would have replaced a measured system with one invented
   in a single session. `design.md` therefore **documents** the implementation and
   says so at the top; `globals.css` and `tailwind.config.ts` remain the
   implementation, and §2 is the contract they satisfy.
2. **No per-step interview.** Requested directly — *"this is an existing project.
   All the things are set."* Every value written is traceable to a file, a test or
   a recorded measurement in the repository, so there was nothing to elicit that
   was not already decided. Anything genuinely undecided was recorded as an **open
   gap** rather than invented.

### Open gaps recorded rather than closed

Named in `security.md` §Conformance so their absence reads as a known bound and
not as coverage: no automated dependency vulnerability scanning; no ESLint config
in `packages/client`; no tenant model on `mcp-bridge`; DNS rebinding narrowed but
not closed; and `core.hooksPath` not set on every workstation, which leaves
article VIII's enforcement layer 2 and article I's commit-time gate inert where
it is unset (measured 2026-08-25 — CI, layer 3, is unaffected).

**Effect**: the standards existence gate is now **armed** and satisfied — all four
required standards exist on disk.

## 2026-09-13 — `security.md` §2: feature-level RBAC

**Feature**: `20260910-130448-feature-rbac-permissions` · **Article VII amendment.**

§2's model line was rewritten and a new **§2.1** added, naming **eight behaviour changes**
— three of them widenings, one a narrowing, and one (behaviour change 6) a state this
deployment enters on day one.

**Why it needed an amendment rather than an edit.** The old §2 described "workspace-scoped
RBAC over an ordered rank". That is now wrong in three ways at once: the unit is a
**permission** rather than a role, the ordering is **set containment** rather than an
integer rank, and there is a **platform tier** above the workspace that the paragraph did
not mention because it did not exist.

**What was deliberately NOT changed.** Every sentence under *"THIS IS NOT SEPARATION OF
DUTIES"* stands verbatim. D-9 widens what a platform administrator can reach and changes
nothing about that: the allowlist is still the un-grantable root, and anything holding
`RUNTIME_JWT_SECRET` still mints any identity.

⚠ **The one sentence this amendment exists to pin**: *a platform administrator cannot see
a tenant's data, but can give themselves the ability to, and doing so leaves an audit entry
naming them.* The shorter version — *"a platform admin cannot access tenant data"* — is
false, and it is the version somebody will write if this is not recorded.
