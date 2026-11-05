# Phase 0 Research: `/speckit-start` Onboarding

Decisions that resolve the unknowns in the plan's Technical Context. Format per
decision: **Decision · Rationale · Alternatives considered**.

## R1. How the existence gate learns "does this project have a UI?"

**Decision**: A machine-readable manifest `.specify/memory/standards.json` is
the single decidable source of truth. It carries `has_ui` (bool),
`status` (`pending` | `established`), the resolved paths of each standard, and
a pointer to amendment history. The gate reads it with `jq` (already a hard
dependency).

**Rationale**: The gate must run in bash on every agent tool call and must be
**decidable without parsing markdown** (a hard constraint from the spec,
FR-019). A boolean in JSON is trivially and reliably readable; a `has_ui:` line
grepped out of a prose `design.md`/`frameworks.md` is brittle and violates the
"no parsing" rule. `jq` is already used by `.claude/hooks/spec-gate.sh` and
`setup.sh`, so no new dependency.

**Alternatives considered**: (a) Grep a marker line from `frameworks.md` —
brittle, parsing-in-gate, rejected. (b) Encode `has_ui` in the branch name or
`init-options.json` — pollutes spec-kit-owned config and doesn't fit per-project
semantics. (c) Separate marker files (`.specify/memory/.has-ui`) — works but
fragments state across several files; one manifest is cleaner and also holds
the pending/established arming state.

## R2. Arming model — how do we force adopters through onboarding without self-blocking template development?

**Decision**: Tri-state arming keyed on the manifest:

| Manifest state | Gate behavior on a source write |
|---|---|
| **absent** | Standards gate **inactive** (falls through to the normal spec gate only). This is the template-dev / pre-`setup.sh` state. |
| **`status: pending`** | **Block all** source writes: "Project standards not established — run `/speckit-start`." |
| **`status: established`** | Require `security.md` (always) and `design.md` (iff `has_ui`). Missing → block naming the standard + `/speckit-start`. Present → allow (conformance deferred to `/speckit-comply`). |

`setup.sh` (run by an adopter cloning the template) writes the **pending**
manifest, which arms the blocking behavior. The template's own repo never runs
that arming step for itself (guarded so `setup.sh` does not overwrite an
existing manifest and does not arm when `.speckit-template-dev` is present), so
template development is not self-blocked.

**Rationale**: This satisfies the user's "you *have to* go through the process"
intent for adopters (a fresh clone is blocked until `/speckit-start` runs) while
avoiding the bootstrapping deadlock where writing the gate code would
immediately block the very session writing it. The `absent` state is the safe
default: no manifest → no standards enforcement, only the pre-existing spec
gate. The existing `.speckit-template-dev` kill-switch (line 43 of
`spec-gate-core.sh`) remains the human escape hatch for template work, exactly
its documented purpose.

**Alternatives considered**: (a) Arm-by-default even when absent (block
everything until standards exist) — cleanest match to intent but creates a hard
self-block mid-`/speckit-implement` and would brick the template repo; rejected
in favor of `setup.sh`-driven arming which achieves the same adopter outcome.
(b) Ship a committed `pending` manifest in the template — would block template
developers themselves; rejected. (c) No arming, standards purely advisory —
fails the core "enforceable" requirement; rejected.

**Bootstrapping note for `/speckit-implement`**: Because this repo has **no
manifest**, the standards gate stays *inactive* while we implement — the code
can be written without self-blocking. The feature's own spec gate (spec + plan
+ tasks present) is what authorizes editing the enforcement source. No
`.speckit-template-dev` file and no `SPECKIT_ENFORCE=0` are needed, and per
AGENTS.md rule 6 the agent will not create them.

## R3. Where standards live and how they load into every session

**Decision**: Standards live under `.specify/memory/` alongside the existing
`constitution.md`: `security.md`, `design.md` (UI only), `frameworks.md`, and
`standards.json`. Session context-loading is achieved by referencing them from
the agent context files (`AGENTS.md` imports them the way `CLAUDE.md` already
imports `AGENTS.md` via `@AGENTS.md`), so they are pulled into every session.

**Rationale**: `.specify/memory/` is already the home of `constitution.md` and
is an always-editable path, so `/speckit-start` can write there without tripping
the gate. `@`-import from `AGENTS.md`/`CLAUDE.md` is the mechanism already used
in this repo for always-on context.

**Alternatives considered**: A top-level `standards/` dir — needless new
location and would need allowlisting; rejected.

## R4. Design mockups + responsiveness verification mechanism

**Decision**: Both design modes emit **standalone static HTML/CSS mockup files**
(no framework/build step) into a scratch location in the adopter's project
(e.g. `docs/design/mockups/`), which the user opens directly in a browser and
resizes. When the Chrome DevTools MCP / `browser-testing-with-devtools` skill is
available, the design step MAY additionally drive the browser at defined
breakpoints (e.g. 375px / 768px / 1280px) to surface overlap/overflow before
approval; when it is not available, manual browser resize is the baseline.

**Rationale**: Framework-free HTML/CSS is instantly viewable and resizable,
directly targeting the "looks fine on desktop, breaks on mobile" pain, and
requires no toolchain. Pixel-perfect visual-regression testing is explicitly
out of scope (spec).

**Alternatives considered**: Framework live-preview / Storybook — heavy setup
before frameworks may even be finalized; rejected for the *approval* loop
(components come *after* approval, R5). Verbal/ASCII description only — cannot
reveal responsive breakage; rejected (this was already ruled out during the
interview).

## R5. Component-library scaffold on design approval

**Decision**: On approval, `/speckit-start` emits design tokens (colors,
spacing, typography, radii, breakpoints) plus a minimal framework-native
component set into the adopter's project, targeting the framework chosen in the
Frameworks step (e.g. a `tokens` module + a handful of primitive components).
The scaffold is produced by the command's instructions at runtime — it is **not**
fixed source shipped by this feature; this feature ships the *instructions and
the token contract*, not a prebuilt React/Tauri library.

**Rationale**: The concrete components depend on the adopter's framework, which
is unknown at template-authoring time. Encoding the "how" in the skill keeps the
template framework-agnostic while still delivering a real, composable library to
each adopter. The approved tokens are the durable contract that both `design.md`
and the components reference.

**Alternatives considered**: Ship prebuilt libraries for N frameworks — huge
surface, most unused, violates YAGNI; rejected. Doc-only design system (tokens
described but nothing scaffolded) — weaker than the confirmed intent; rejected.

## R6. Pull-time compliance review delivery

**Decision**: Add `.githooks/post-merge` and `.githooks/post-checkout`, each a
thin wrapper calling a shared `ci/check-standards-compliance.sh` in **report-only**
mode over the incoming diff (the merge/checkout range). Hooks are auto-active
because `setup.sh` already sets `git config core.hooksPath .githooks` and
chmods `.githooks/*`. The same review script is reused by `/speckit-comply`.

**Rationale**: Reuses the exact wiring the repo already has for `pre-commit` /
`pre-push`. `post-merge` covers `git pull` (ff + merge); `post-checkout` covers
branch switches / clones — together they cover "new code arrived." Report-only
matches FR-025 (never block/revert a pull).

**Alternatives considered**: CI-only integration — out of scope per spec and
misses the local "on pull" moment. A single `post-merge` — misses checkout
arrivals. A `pre-*` hook — would risk blocking, violating read-only intent.

## R7. Conformance checking — how deep, and by whom

**Decision**: Conformance (does this code honor the standards' content?) is a
**judgment task performed by the agent**, invoked from `/speckit-comply` and
from the pull-time review script, which loads the standards + the diff and
reports findings by severity (CRITICAL/HIGH/MEDIUM/LOW). The bash gate never
judges conformance; it only checks existence (FR-019/FR-020). The bash
`post-merge`/`post-checkout` hooks perform the cheap, decidable part (are the
standards present? did the diff touch UI/security-relevant paths?) and print a
prompt directing the developer to run the agent-driven `/speckit-comply` for the
full conformance judgment.

**Rationale**: Design/security conformance is inherently non-decidable in bash;
it is exactly the kind of review the existing `/speckit-comply` already performs
against spec/tasks. Extending it to also compare against `security.md`/`design.md`
is the natural fit. The git hook stays fast and read-only, deferring the
subjective judgment to the agent.

**Alternatives considered**: Regex/linter-based conformance in bash — cannot
capture design-token or security-posture adherence meaningfully; rejected as the
primary mechanism (a linter could be a future add-on).

## R8. Testing approach (repo has no test framework today)

**Decision**: Add `tests/standards-gate/` with a small runner that prefers
`bats-core` if installed and otherwise executes plain-bash assertion scripts.
Tests build throwaway fixture repos (temp dirs) and assert
`spec-gate-core.sh` exit codes and messages across the arming matrix (absent /
pending / established × security-missing / design-missing / has_ui true|false /
always-editable path) and assert `check-standards-compliance.sh` report output.

**Rationale**: Satisfies Constitution Article II for the executable
(gate/review) logic without imposing a heavy dependency. Fixture-based tests are
how gate behavior is best proven.

**Alternatives considered**: No tests (rely on quickstart only) — violates
Article II for executable code; rejected. Mandatory `bats` — adds a dependency
not present today; made optional instead.

## R9. Agent-surface parity

**Decision**: Ship both new commands on all four surfaces: `SKILL.md` under
`.claude/skills/`, `.agents/skills/`, `.cursor/skills/`, and a `.toml` under
`.gemini/commands/` (Gemini uses dotted names: `speckit.start`,
`speckit.update-standards`). No new `extensions.yml` hooks are required
(these are core commands, not lifecycle hooks); optional `after_*` git-commit
behavior already exists globally.

**Rationale**: Matches the repo's existing convention where every `speckit-*`
command is present on all four surfaces. Keeps enforcement identical regardless
of which agent an adopter uses (AGENTS.md requirement).

**Alternatives considered**: Claude-only — breaks multi-agent parity the
template promises; rejected.

## R10. Amendment history tracking

**Decision**: `/speckit-update-standards` appends a structured entry to a
history log (`.specify/memory/standards-history.md`) and bumps a
`revision`/`last_amended` field in `standards.json` for each change, recording
what changed, which file, and (prompted) why. The prior content remains
recoverable via git history; the log is the human-readable audit trail.

**Rationale**: Satisfies FR-022 (tracked, auditable history) with a simple
append-only doc plus a manifest revision counter. Git already versions the
files; the log makes the "why" explicit without a bespoke versioning system.

**Alternatives considered**: Rely on git history alone — loses the "why" and is
harder to review at a glance; rejected. A full semantic-versioning scheme per
standard — over-engineered for this need (YAGNI); the constitution already has
its own versioning line, which `/speckit-update-standards` will keep updating.
