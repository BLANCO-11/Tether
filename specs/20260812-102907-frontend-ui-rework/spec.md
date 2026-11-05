# Feature Specification: Frontend UI rework — three modes, one editable DAG

**Feature Branch**: `20260812-102907-frontend-ui-rework`

**Created**: 2026-08-12

**Status**: Draft

**Input**: User description: "rethink the layouts, sizes, positions etc. especially for the whole
automation page and its relevant pages… we are having three modes for workflow creation right, let's
make it simpler: chat based, template based and a manual builder mode… for chat based workflow
creation i want langdock type system, a chat area and a workflow visualization area where user can
also edit stuff and on the go a chat area is there in case user wants to instruct ai to change the
workflow… stackAI for manual builder… the workflows visible to the user on the DAG visual component
should all be editable from nodes to links to inputs and outputs etc. it's not just there for
visualization but it is also editable like langflow, dify workflows… I want you to create a plan
around this, a new plan with phases for implementation."

The authoritative engineering plan for this work is
[`plans/frontend-2026-08-12/plan.md`](../../plans/frontend-2026-08-12/plan.md) (with its phase
directories, findings and boards). This spec is the agent-gate-facing contract for that plan; the
plan is the master index of phases, tasks, decisions and evidence.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Author a workflow by chatting (Priority: P1)

A user wants to build a workflow without learning the builder. They open the automation page, pick
the chat door, and describe what they want. The chat accepts either a one-line goal ("email me the
report every morning") or a pasted multi-line step list — both forms work. As the conversation
progresses, a live visualisation of the workflow appears next to the chat and updates as turns
land. The user can interrupt any time to drag nodes, reconnect links or edit fields by hand, and
can tell the chat to change something mid-editing without losing their manual arrangement.

**Why this priority**: Chat is the mode whose journey changes most (it absorbs the old outline and
goal modes) and it is what the user named first. The chat backend already exists — the surface and
the routing are the deliverable.

**Independent Test**: In a fresh workspace, start a chat with a multi-line step list and confirm
the flow is built through the existing outline path; then start another chat with a one-line goal
and confirm the goal path. Both must produce a workflow visible on the canvas.

**Acceptance Scenarios**:

1. **Given** a fresh `/flows/new` in chat mode, **When** the first message is a multi-line step
   list, **Then** the flow is generated via the outline path and every listed step appears as a
   node.
2. **Given** the same surface, **When** the first message is a one-line goal, **Then** the flow is
   generated via the goal path with no step list required.
3. **Given** an ongoing chat with a generated workflow, **When** the user manually drags a node,
   **Then** the position persists and a later chat turn does not reset it.
4. **Given** a refusal (e.g. an insufficient contract) during chat, **When** the user clicks the
   "Fix in chat" affordance, **Then** the finding is carried into a new chat turn and the refusal
   is never auto-fixed or retried silently.
5. **Given** a chat turn applying an edit, **When** it lands, **Then** the canvas updates live and
   the UI says which component changed.

### User Story 2 - Build a workflow by hand with an editable DAG (Priority: P1)

A user wants full control. They pick the manual builder door and build a workflow on a canvas
where every element is editable: nodes can be added, dragged, reconnected, re-routed, deleted and
undone; node inputs and outputs can be edited on the canvas; the arrangement they make is saved
with the flow and survives reload, revisions and viewing on the flow and run pages. When their
hand arrangement goes stale (steps renamed or removed), a "re-arrange" button returns the graph to
an automatic layout.

**Why this priority**: The editable DAG is the single largest ask ("editable from nodes to links to
inputs and outputs") and the platform Phases 3 and 5 stand on.

**Independent Test**: Build a five-step flow by hand — add, move, connect, re-route, delete, undo —
then reload the page and confirm positions persisted.

**Acceptance Scenarios**:

1. **Given** the manual builder canvas, **When** the user drags a node, **Then** its position is
   saved outside the flow revision and survives a reload.
2. **Given** a hand-arranged graph, **When** the user connects two handles, **Then** a link is
   added; a self-link, a missing end, a duplicate and a cycle are refused with a clear message.
3. **Given** an existing link, **When** the user re-routes it from a different output handle,
   **Then** the link moves without delete-and-recreate.
4. **Given** any editing gesture, **When** the user presses undo, **Then** the last change is
   reverted (and redo restores it).
5. **Given** steps added or removed since a saved arrangement, **When** the user clicks
   "re-arrange", **Then** the graph returns to a clean automatic layout and the stale saved
   positions no longer apply.
6. **Given** a flow with a saved arrangement, **When** it is viewed on the flow page or the run
   page, **Then** it shows the same arrangement, not a different auto-layout.

### User Story 3 - Start from a curated blueprint with a ref-mapping step (Priority: P2)

A user wants a head start. They pick the template door, choose from a shelf of curated blueprints,
and walk an instantiation step in which each template reference is shown and mapped to their own
workspace's tools and datasources. Nothing is guessed: a ref that cannot be mapped is reported as a
mapping problem with a clear way to fix it, and instantiation only proceeds once every ref is
mapped.

**Why this priority**: Templates already save/plan/instantiate — the curation shelf and the
mapping UI are the deliverables, and the mode must exist before the chooser (Phase 6) can be
honest.

**Independent Test**: Pick a blueprint, walk the mapping step with every ref mapped, instantiate,
and confirm the result passes through the normal review path.

**Acceptance Scenarios**:

1. **Given** the template shelf, **When** a card is viewed, **Then** it says what references the
   blueprint needs, before instantiation.
2. **Given** the instantiation walk, **When** a ref is unmapped, **Then** instantiation is refused
   and the missing ref is named as the reason.
3. **Given** every ref mapped, **When** the user instantiates, **Then** a draft flow is created and
   passes through the standard review, and a name collision returns a 409 with a clear message.

### User Story 4 - Edit an armed automation without stopping it (Priority: P2)

A user has an automation that is approved and running (armed). They open it and edit the workflow.
The edit writes a draft revision; the armed version keeps running untouched. A persistent banner
says which revision is live and which one is being edited. Re-approval promotes the draft; until
then the schedule keeps running the armed revision. An execution's page stays read-only — the
graph it ran is history.

**Why this priority**: This is the mode most likely to be used wrong; the write path and the
approval gate already exist, so the deliverable is the editable page plus honest labelling.

**Independent Test**: Edit an armed flow, confirm the draft revision is created, the armed revision
keeps running, the banner names both, and re-approval promotes the draft.

**Acceptance Scenarios**:

1. **Given** an armed flow with revision v3 running, **When** the user edits and saves on the flow
   page, **Then** a draft revision v4 is written and v3 keeps running untouched.
2. **Given** a draft pending, **When** the user views the flow page, **Then** a persistent banner
   names which revision is live and which is being edited.
3. **Given** an armed flow with a draft pending, **When** the schedule fires, **Then** it runs the
   armed revision, not the draft.
4. **Given** a run page, **When** the user views it, **Then** there is no edit affordance; the
   graph shown is the one that actually ran.

### User Story 5 - The three modes read as one product (Priority: P3)

A user arriving at `/flows/new` sees three doors — chat, template, manual builder — instead of the
current four cards. Outline and goal are visibly absorbed into chat's first message. The modes
share one vocabulary (step/component/node; draft/live/armed) and one way to say "here is what is
wrong and what you can do". A flow started in one mode can be finished in another without losing
work or arrangement.

**Why this priority**: Journey coherence across the modes and pages is what makes the rework feel
like one product; it lands last because it must be designed against the modes as they will be.

**Independent Test**: Start a flow in chat, finish it by hand on the canvas, and confirm nothing
is lost; repeat for template → manual refine.

**Acceptance Scenarios**:

1. **Given** `/flows/new`, **When** the chooser is shown, **Then** exactly three doors render and
   the old four-mode cards are gone.
2. **Given** a user who came to paste steps, **When** they open the chat door, **Then** the
   step-list path is present and obvious inside chat.
3. **Given** a flow started in any mode, **When** it is finished in another mode, **Then** no work
   and no arrangement is lost.
4. **Given** any refusal surface (draft, contract, catalogue, chat, mapping), **When** it renders,
   **Then** it uses the same refusal grammar as every other surface.

### Edge Cases

- A hand-arranged graph goes stale: steps renamed or removed after a position was saved — the
  reconciliation rule decides what happens; the "re-arrange" button is always available.
- A drag must never create a revision and invalidate an approval — cosmetic layout and flow
  content are stored separately.
- A workspace with no templates must not read as "nothing here" — the shelf has an honest empty
  state.
- A blueprint whose refs were written against another tenant's data — the mapping step exists
  precisely so a ref mismatch is a mapping problem, not a broken product.
- Chat on a small window: the workbench must still fold so chat and canvas do not fight for
  space.
- The 1024-token chat turn cap is untouched; a model change invalidates measured chat numbers, so
  every measurement records the model it was taken on.
- Nothing in this repo has ever been seen rendered in a browser — every phase that touches a
  surface owns a browser walk of that surface.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: The system MUST present exactly three authoring modes — chat, template, manual
  builder — replacing the current four-mode chooser; outline and goal MUST be absorbed into chat's
  first message, where a multi-line step list routes to the outline path and a one-line goal
  routes to the goal path. (decision ①)
- **FR-002**: The workflow DAG MUST be editable everywhere it is shown: nodes draggable, links
  addable/removable/re-routable, node fields and inputs/outputs editable on the canvas, with
  undo/redo. (decision ②, Phase 2)
- **FR-003**: Node positions MUST be persisted outside the flow revision, keyed to (flow, step);
  a drag MUST never write a revision or invalidate an approval; a reconciliation rule and a
  "re-arrange" button MUST cover stale arrangements. (decision ②)
- **FR-004**: Chat MUST render alongside a live, editable canvas (Langdock-style); applied turns
  MUST update the DAG live; a "Fix in chat" affordance MUST carry refusal findings into a turn and
  never auto-fix; no new chat endpoint that takes a goal MAY be added. (decision ①, Phase 3)
- **FR-005**: Template mode MUST be curated blueprints with a ref-mapping instantiation step;
  every ref MUST be visible and mappable before instantiation, and instantiation MUST refuse with
  the missing ref named when a ref is unmapped. (decision ③)
- **FR-006**: Editing an armed flow on the flow page MUST write a draft revision; the armed
  revision MUST keep running untouched; a persistent banner MUST name which revision is live vs
  which is being edited; the run page MUST stay read-only. (decision ④)
- **FR-007**: The four pages (`/flows`, `/flows/new`, `/flows/[id]`, `/runs/[id]`) MUST share one
  geometry language (measures, zones, canvas full-bleed semantics, node anatomy); only the page
  container MAY set a width.
- **FR-008**: The system MUST refuse invalid graph operations (self-link, missing end, duplicate,
  cycle) with a clear message and MUST never retry a refused generation automatically.
- **FR-009**: Every phase that touches a surface MUST record a browser walk of that surface in
  its phase evidence; an empty browser row means the phase is not finished.

### Key Entities *(include if feature involves data)*

- **Flow step positions**: coordinates for a step within a flow, stored outside the flow revision
  (the plan's only migration); keyed (flow, step), workspace-scoped, reconciled on step changes.
- **Draft revision**: an edit of an armed flow's revision that has not been re-approved; the
  armed revision continues to run; approval binds to a revision, never to a flow.
- **Blueprint (template)**: a curated, human-owned bundle captured at save time with a ref-mapping
  step at instantiation; workspace-scoped; name collision is a 409.
- **Chat thread/turn**: existing backend entities (8 ops, 1024-token cap); the first-message
  goal/step-list split is a client-side routing decision only.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: A user can author a workflow from a pasted step list via chat and see every step as
  a node (outline path, the measured-good route) — 100% of the listed steps accounted for.
- **SC-002**: A hand-built five-step flow (add, move, connect, re-route, delete, undo) can be
  built entirely on the canvas, and a drag persists across reload — no gesture requires leaving
  the canvas.
- **SC-003**: A drag never creates a revision: zero revision writes attributable to positional
  edits, pinned by test.
- **SC-004**: An armed flow edit creates a draft revision and the armed revision keeps running —
  asserted for the page edit, chat and refine paths; the banner names both revisions in both
  directions.
- **SC-005**: A blueprint instantiates only when every ref is mapped; an unmapped ref produces a
  refusal naming the ref — no silent inference.
- **SC-006**: All four pages render in a browser at the agreed geometry, each with its browser
  row filled in evidence; `chat:measure` produces a number recorded with its model.
- **SC-007**: The gate set is green at the end of every phase: typecheck 0 · package tests ·
  `ui-honesty-check.sh` 0 FAIL · `kestra:check` 0 SKIP · `e2e:ui` at two periods ·
  `scenarios:verify` 13/13 · `finance:verify` · `demo:verify`+`demo:rehearse` · `backup:verify`
  after any migration · `showcase:seed` immediately before `showcase:verify`.

## Assumptions

- The plan at `plans/frontend-2026-08-12/` is authoritative for ordering, phases, decisions and
  evidence; this spec is the gate-facing contract, not a second plan.
- The backend is already most of the way there: chat, the revision gate, templates and the
  catalogue exist; the genuinely new backend work is one positions table and two client-routed
  decisions.
- Positions are stored outside the revision so a cosmetic drag never invalidates an approval.
- Chat's first-message split is client-side only; the design forbids a goal-taking chat route.
- The run page stays read-only; an execution's graph is history.
- Dashboard, history and org/admin pages are out of scope for layout work (user decision
  2026-08-12).
- Nothing has been seen rendered in a browser (I-80); every phase owns a browser task for its
  surfaces, and every measurement records the model it was taken on.
- Phase order and parallelism: 1 → 2 → (3 ‖ 4) → 5 → 6, per the plan's dependency argument.
