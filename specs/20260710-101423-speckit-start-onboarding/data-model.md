# Phase 1 Data Model: `/speckit-start` Onboarding

The "data" here is the set of on-disk standards artifacts and the manifest that
makes the gate decidable. No database. All paths are relative to the adopting
project root.

## Entity overview

```text
.specify/memory/
├── constitution.md          # Constitution standard (already ships; onboarding may update)
├── frameworks.md            # Frameworks record (human-readable)
├── security.md              # Security standard
├── design.md                # Design standard (ONLY when has_ui)
├── standards.json           # Manifest — decidable source of truth for the gate
└── standards-history.md     # Amendment audit log (append-only)
```

---

## 1. Standards Manifest — `.specify/memory/standards.json`

The single machine-readable record the bash gate reads. See the JSON Schema in
[contracts/standards-manifest.schema.json](./contracts/standards-manifest.schema.json).

| Field | Type | Required | Description |
|---|---|---|---|
| `schema_version` | integer | yes | Manifest schema version (starts at `1`). |
| `status` | enum `pending` \| `established` | yes | Arming state. `pending` = onboarding not finished (block all source). `established` = onboarding complete. |
| `has_ui` | boolean \| null | yes | Whether the project has a UI. `null` only while `pending` and undetermined. |
| `standards` | object | yes | Map of standard key → record (see below). |
| `frameworks` | string[] | no | Chosen frameworks (informational; mirrors `frameworks.md`). |
| `revision` | integer | yes | Bumped on every amendment (starts at `1`). |
| `created` | string (ISO date) | yes | When onboarding first established standards. |
| `last_amended` | string (ISO date) | no | Last amendment date. |
| `history_log` | string (path) | no | Path to `standards-history.md`. |

### `standards[key]` record

Keys: `constitution`, `frameworks`, `security`, `design`.

| Field | Type | Required | Description |
|---|---|---|---|
| `path` | string | yes | Repo-relative path to the standard file. |
| `required` | boolean | yes | Whether the existence gate blocks when this file is missing. `security` = always true; `design` = `has_ui`; `constitution`/`frameworks` = true. |
| `present` | boolean | yes | Whether the file currently exists (written/refreshed by the commands; the gate re-checks the filesystem regardless). |
| `established` | string (ISO date) | no | When this standard was first completed. |

### State transitions

```text
(absent manifest)              # gate inactive — template-dev / pre-setup
      │  setup.sh (adopter)
      ▼
status=pending, has_ui=null    # gate blocks ALL source writes → "run /speckit-start"
      │  /speckit-start completes all applicable steps
      ▼
status=established             # gate requires security(+design if has_ui)
      │  /speckit-update-standards (revision++, last_amended, history entry)
      ▼
status=established (revised)   # required set may change if has_ui is corrected
```

### Validation rules

- `status=established` ⇒ `has_ui` is a boolean (not null).
- `has_ui=true` ⇒ `standards.design.required=true`.
- `has_ui=false` ⇒ `standards.design.required=false` (design gate never fires).
- `standards.security.required` is always `true`.
- `revision` is monotonically increasing; `last_amended >= created`.
- The gate treats a malformed/unreadable manifest as **fail-open** (allow), to
  honor the "never brick the agent" constraint — logged, not blocking.

---

## 2. Constitution standard — `.specify/memory/constitution.md`

- **Represents**: project governing principles (already exists as a starter).
- **Produced/updated by**: `/speckit-start` (Constitution step), `/speckit-update-standards`, and the existing `/speckit-constitution`.
- **Key content**: numbered principles, enforcement description, governance +
  version line (the existing `**Version**: X.Y.Z` footer is kept current).
- **Relationships**: referenced by the gate messages and by `/speckit-comply`.

## 3. Frameworks record — `.specify/memory/frameworks.md`

- **Represents**: the chosen technology frameworks and the UI determination.
- **Produced by**: `/speckit-start` (Frameworks step).
- **Key content**: chosen frameworks + versions/rationale; an explicit
  **"Has UI: yes/no"** statement and how it was decided (user-stated vs inferred);
  any framework-specific conventions.
- **Relationships**: `has_ui` here is mirrored into `standards.json` (the manifest
  is authoritative for the gate). Drives whether the Design step runs.

## 4. Security standard — `.specify/memory/security.md`

- **Represents**: the project security posture. **Required for every project.**
- **Produced by**: `/speckit-start` (Security step), amended via `/speckit-update-standards`.
- **Key content (minimum sections)**: Authentication; Authorization/access
  control; Data protection (in transit/at rest, PII handling); Secrets
  management (env/secret-store, never hardcoded — ties to constitution art. VIII);
  Dependency/supply-chain posture; Threat considerations relevant to the chosen
  frameworks.
- **Invariant**: MUST NOT contain real credentials (enforced by the existing
  content scanner on write).
- **Relationships**: checked for existence by the gate; checked for conformance
  by `/speckit-comply` and the pull-time review.

## 5. Design standard — `.specify/memory/design.md`

- **Represents**: the enforceable UI/UX design system. **Exists only when `has_ui`.**
- **Produced by**: `/speckit-start` (Design step) after explicit approval;
  amended via `/speckit-update-standards`.
- **Key content**: design tokens (color, typography, spacing, radii, elevation),
  responsive breakpoints + rules, layout/grid conventions, component inventory,
  accessibility baseline, and the chosen design mode + reference (if any).
- **Relationships**: the approved tokens are the contract the scaffolded
  component library implements (see entity 7). Gated on existence only when
  `has_ui`.

## 6. Design mockup(s) — `docs/design/mockups/*.html` (+ css)

- **Represents**: resizable static approval artifacts.
- **Produced by**: `/speckit-start` Design step, revised across feedback rounds.
- **Lifecycle**: transient/approval-time; retained under `docs/` for reference.
  Not gated. Must remain usable at mobile widths before approval.

## 7. Component library scaffold — (adopter project, framework-specific path)

- **Represents**: framework-native components + a tokens module carrying the
  approved design tokens.
- **Produced by**: `/speckit-start` on design approval, per the chosen framework.
- **Relationships**: consumes tokens defined in `design.md`; future feature work
  composes from it. Not fixed source shipped by this feature.

## 8. Amendment history entry — `.specify/memory/standards-history.md`

- **Represents**: an append-only audit record of standards changes.
- **Produced by**: `/speckit-update-standards` (and `/speckit-start` re-runs that alter standards).
- **Fields per entry**: date, standard(s) touched, summary of change, reason
  ("why"), and revision number after the change.
- **Relationships**: `standards.json.revision`/`last_amended` correspond to the
  latest entry.

## 9. Compliance finding (transient, produced by review)

- **Represents**: a single reported (non-)conformance of a change to a standard.
- **Produced by**: `/speckit-comply` and the pull-time review script.
- **Fields**: severity (CRITICAL/HIGH/MEDIUM/LOW), standard + section referenced,
  file/location, description, suggested remediation.
- **Lifecycle**: report-only; never persisted as a gate state, never blocks a pull.
