# Feature Specification: Automation UI redesign — StackAI / Langdock / Langflow structure

**Feature Branch**: `20260812-205352-automation-ui-redesign`

**Created**: 2026-08-12

**Status**: Draft

**Input**: User description: "revisit the UI, especially for the whole automation creation logic —
inspired exactly like layouts of StackAI, Langdock and Langflow respective to the types of build
type. Redesign the page; think about spacing, fonts, components, effects, behaviour, page layouts.
Keep it consistent and structural based on the nature of what the page represents."

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Manual builder reads as a canvas-first node builder (Priority: P1)

A user who wants full control picks the **manual builder** door and is met with a canvas-first
surface in the spirit of Langflow: a searchable component palette along the left, an open canvas
in the centre, and an inspector along the right that opens when a node is selected. Every node is
drawn with a clear identity — a coloured category marker plus its name and kind in words — and
the palette is grouped by component category so the user can scan for a step by what it does
rather than by name. Zoom and minimap affordances are present so a large graph stays navigable.

**Why this priority**: The manual builder is the mode the user has named most often ("editable from
nodes to links to inputs and outputs") and it is the surface where the Langflow inspiration is the
strongest. It is the largest single redesign and everything else borrows its canvas anatomy.

**Independent Test**: Open the manual builder in a fresh workspace, confirm the three-region layout
(palette / canvas / inspector) is present, add a component by dragging or clicking from the palette,
select it, edit a field in the inspector, and confirm the graph updates. No other surface is needed
to verify this story.

**Acceptance Scenarios**:

1. **Given** the manual builder, **When** it renders, **Then** the screen shows three regions: a
   component palette on the left, a canvas in the centre, and an inspector on the right.
2. **Given** the palette, **When** the user types in the palette's search box, **Then** the
   component list filters to matching entries.
3. **Given** the palette, **When** the user adds a component to the canvas, **Then** a node appears
   with a category marker and its kind stated in words (colour is never the only carrier).
4. **Given** a node on the canvas, **When** the user selects it, **Then** its editable fields and
   inputs/outputs open in the right-hand inspector.
5. **Given** a graph larger than the viewport, **When** the user zooms or uses the minimap, **Then**
   the graph remains navigable.

### User Story 2 - Chat mode reads as a conversation beside a live workflow (Priority: P1)

A user who wants to build by talking picks the **chat** door and is met with a Langdock-style
surface: a conversation composer on one side and the workflow it is building on the other. As each
turn is applied the workflow updates live, and the user can interrupt to drag a node or tell the
chat to change something without losing their arrangement. The two panes are always both usable —
on a narrow window they stack rather than squeeze.

**Why this priority**: Chat is the mode whose journey changed most in the prior rework and it is
the user's first-named inspiration (Langdock). It shares the canvas anatomy with the manual builder,
so it must land in step with it.

**Independent Test**: Start a chat, send a one-line goal, confirm a workflow appears beside the
conversation and updates as turns land, then manually drag a node and confirm the position persists.

**Acceptance Scenarios**:

1. **Given** chat mode, **When** it renders, **Then** the conversation and the live workflow are
   visible side by side.
2. **Given** an applied chat turn, **When** it lands, **Then** the workflow beside the chat updates
   to reflect it without a full-page navigation.
3. **Given** chat mode on a narrow window, **When** the viewport shrinks, **Then** the two panes
   stack rather than squeeze below a usable width.
4. **Given** a hand-arranged graph in chat mode, **When** a later chat turn applies, **Then** the
   user's arrangement is preserved.
5. **Given** chat mode, **When** the conversation renders, **Then** it reads as a clean, elegant
   chat — the user's messages are bubbles, the computed results are quiet cards, and the composer
   is a simple input bar (no heavy chrome).
6. **Given** a node on the chat canvas, **When** the user clicks it, **Then** a right-hand sidebar
   expands showing that node's kind, reference, dependencies and contract, and it is editable — the
   user can turn retry on or off, require an approval before the step, or remove the step.

### User Story 3 - Template mode reads as a browsable block library (Priority: P2)

A user who wants a head start picks the **template** door and is met with a StackAI-style library:
the workspace's curated blueprints presented as a browsable, searchable collection grouped by
category, where each card states what references it needs before anything is instantiated. Choosing
a blueprint leads into the mapping walk, which is its own distinct step.

**Why this priority**: The template mode already functions; the deliverable here is the library
presentation (browsable, categorised, honest cards) rather than new behaviour, so it ranks below
the two P1 surfaces.

**Independent Test**: Open the template door in a workspace with at least one blueprint, confirm the
shelf is browsable and searchable with visible category grouping, open a blueprint, and confirm its
needed references are stated before instantiation.

**Acceptance Scenarios**:

1. **Given** the template door, **When** it opens, **Then** the blueprint shelf renders as a
   browsable, searchable, category-grouped library.
2. **Given** a blueprint card, **When** it is viewed, **Then** it states what references the
   blueprint needs, before instantiation.
3. **Given** a workspace with no blueprints, **When** the shelf renders, **Then** it shows an honest
   empty state rather than reading as broken.

### User Story 6 - A user can author a template by describing it (Priority: P2)

A user who wants a blueprint that does not exist yet can open the template surface and choose
**"Build it for me"**: they describe the automation in one box, Foundry drafts the flow (the same
generation path the chat door uses), and the result is snapshotted straight into the workspace's
template shelf — no separate visit to a flow page to press "Save as template".

**Why this priority**: Templates are currently only created by saving an existing flow, so a
workspace cannot grow its own library without first building a flow elsewhere. This closes that
gap without inventing a new write path — the flow is generated by the existing job and snapshotted
by the existing `saveFlowTemplate`.

**Independent Test**: Open the template surface, describe an automation, choose "Build it for me",
and confirm the draft is generated, snapshotted as a template, and appears on the shelf.

**Acceptance Scenarios**:

1. **Given** the template surface, **When** it renders, **Then** a "Build it for me" affordance is
   present beside the browseable shelf.
2. **Given** a description in the "Build it for me" box, **When** the user submits it, **Then** the
   generation runs with visible progress, and on success the result is saved as a workspace template
   and the shelf refreshes to show it.
3. **Given** a refused generation, **When** the job finishes, **Then** the refusal is stated on the
   surface and nothing is saved as a template.

### User Story 4 - Flow and run pages share the same canvas language (Priority: P2)

A user who opens an existing automation on its flow page, or looks at a finished execution on its
run page, sees the same DAG anatomy as the builder — same node identity, same status language, same
spacing. The flow page remains editable where the run page is read-only, and the armed-vs-draft
labelling is unchanged.

**Why this priority**: A flow that looks different on the detail page from the one the user just
built breaks the "one product" promise; this story extends the shared canvas anatomy to the two
read paths.

**Independent Test**: Open an existing flow's page and a run's page and confirm both render the same
node anatomy and status language as the manual builder; confirm the run page shows no edit
affordance.

**Acceptance Scenarios**:

1. **Given** a flow page, **When** it renders, **Then** the DAG shows the same node anatomy and
   status language as the manual builder.
2. **Given** a run page, **When** it renders, **Then** the DAG is shown read-only, with no edit
   affordance.
3. **Given** an armed flow with a pending draft, **When** the flow page renders, **Then** the
   armed-vs-draft banner still names which revision is live and which is being edited.

### User Story 5 - The three modes read as one product (Priority: P3)

Across the three doors and the flow/run pages, one typography scale, one spacing rhythm and one
motion vocabulary are used. A step is called the same thing everywhere; a panel is the same panel
everywhere; the surfaces differ by what they are for, never by accident of who built them.

**Why this priority**: Coherence is what makes the redesign feel intentional; it is verified last
because it must be judged against the surfaces as they actually render.

**Independent Test**: Walk the three doors and the two detail pages and confirm a shared set of
layout rules (panel corners, section labels, node identity, spacing increments) is applied
consistently.

**Acceptance Scenarios**:

1. **Given** any of the three mode surfaces, **When** it renders, **Then** it uses the same
   typography scale and spacing rhythm as the others.
2. **Given** any refusal surface (draft, contract, catalogue, chat, mapping), **When** it renders,
   **Then** it uses the same refusal grammar as every other surface.
3. **Given** a user who has seen one mode, **When** they open another, **Then** the shared anatomy
   makes the new mode recognisable without explanation.

### Edge Cases

- **Narrow window**: the chat and manual-builder surfaces must fold (stack) rather than squeeze a
  canvas below the width at which a relationship is still readable.
- **Reduced motion**: any new motion (hover, transition, edge crawl) must stop for users who have
  asked their OS not to animate.
- **Colour-blind readability**: a node's category/kind is always stated in words; colour is never
  the only carrier of a step's kind or status.
- **Empty palette/shelf**: a workspace with no components or no blueprints must show an honest empty
  state, not a blank region that reads as broken.
- **The palette must not regress the refusal grammar**: a search that finds nothing and a blueprint
  that cannot be instantiated are both "here is what is wrong and what you can do" surfaces, not
  errors with retry buttons.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: The manual builder MUST present a three-region layout — a component palette on the
  left, a canvas in the centre, and an inspector on the right — and the palette MUST be searchable
  and grouped by component category, with a visual marker per category.
- **FR-002**: Selecting a node on the canvas MUST open that node's editable fields and inputs/outputs
  in the inspector, and the graph MUST reflect edits without leaving the canvas.
- **FR-003**: The canvas MUST offer zoom and minimap affordances so a graph larger than the viewport
  remains navigable.
- **FR-004**: The chat mode MUST present the conversation and a live workflow side by side, and the
  workflow MUST update as each applied turn lands without a full-page navigation.
- **FR-005**: The template mode MUST present the blueprint shelf as a browsable, searchable,
  category-grouped library, and each card MUST state its needed references before instantiation.
- **FR-006**: The flow and run pages MUST render the same DAG anatomy and status language as the
  builder; the run page MUST remain read-only.
- **FR-007**: All redesigned surfaces MUST share one typography scale, one spacing rhythm and one
  motion vocabulary, and MUST reuse the existing dual palette (dark and light) as the only source
  of colour — no new colours may be introduced.
- **FR-008**: The redesign MUST NOT change behaviour: the three doors, chat first-message routing,
  the ref-mapping refusal, the armed-vs-draft banner and the refusal grammar MUST all behave as
  before; only presentation changes.
- **FR-009**: Every surface the redesign touches MUST record a browser walk of that surface in the
  feature's evidence, and MUST stay green against the project gate set.
- **FR-010**: All new motion MUST respect a reduced-motion preference, and all surfaces MUST fold
  (rather than squeeze) below their usable width.
- **FR-011**: The chat surface MUST present the conversation as a clean chat (message bubbles and a
  simple composer bar) beside the live workflow preview, and MUST expand a right-hand inspector when
  a node is selected, showing that node's kind, reference, dependencies and contract, with the same
  narrow edits as the flow page (retry on/off, require approval before the step, remove the step).
- **FR-012**: The three creation surfaces and the flow/run detail pages MUST compose from one
  explicit UI hierarchy, with each layer owning exactly one concern: **tokens** (colour, type scale,
  spacing, motion) → **atoms** (`ui/` controls) → **composites** (`pane`, workbench, node, inspector,
  shelf) → **pages** (`Page` → `Zone` → workbench/pane → content). The type scale MUST be a closed
  seven-step set — `micro` (10px), `caption` (11px), `xs` (12px), `body` (13px), `sm` (14px),
  `lg` (18px), `xl` (20px) — and no surface may use a size outside it (the half-pixel `11.5px`/
  `12.5px` and the `9px` literals are removed). Positioning MUST follow the existing ownership
  rules: `Page` owns measure and the zone gap, a `Zone` owns its intra-zone gap, the workbench owns
  the input/canvas split and its fold, a pane owns its inset, and the canvas owns its height.
- **FR-013**: The template surface MUST offer a "Build it for me" path that authors a template from a
  description: the user writes a goal, the surface runs the EXISTING generation job
  (`startFlowGeneration` → poll `getFlowGenerationJob`) with visible progress, and on success
  snapshots the resulting flow as a workspace template through the EXISTING `saveFlowTemplate`
  path, then refreshes the shelf. No new endpoint, no new data shape.

### Key Entities

No new data entities are introduced. The redesign introduces one shared, cross-cutting artefact: a
**design language** expressed through the project's existing design tokens, which the three mode
surfaces and the two detail pages compose from. Its layers are:

1. **Tokens** (`globals.css` + `tailwind.config.ts`): colour (existing dual palette), a closed
   **type scale** (`micro` 10 / `caption` 11 / `xs` 12 / `body` 13 / `sm` 14 / `lg` 18 / `xl` 20),
   the 4px **spacing** base, and a **motion** vocabulary (`--dur-fast` 120ms / `--dur-base` 180ms,
   one easing curve, all disabled under `prefers-reduced-motion`).
2. **Atoms** (`components/ui/`): `Button`, `Field`/`Input`/`Select`/`Textarea`, `Badge`, `Notice`,
   `Tile`, `Choice`, `Modal` — the only elements allowed to define interactive chrome.
3. **Composites** (`components/layout/`, `components/flow/`): `Page`/`Zone`/`PageHeader`,
   `Workbench`/`WorkbenchPane`/`WorkbenchHead`/`WorkbenchBody`, the `.pane`/`.pane-head` box idiom,
   the canvas node, the inspector, and the library shelf.
4. **Pages** (`app/(app)/flows/*`, `app/(app)/runs/[id]`): one `Page`, one fixed zone order
   (header → notices → controls → content → related), one workbench or pane per concern.

**Positioning hierarchy** (who owns what space): `Page` owns the measure and the gap between zones;
a `Zone` owns the gap between its own children; the `Workbench` owns the input/canvas split and its
fold; a `pane` owns its own inset; the canvas owns its own height (density). No layer reaches into
another layer's spacing.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: In the manual builder, a user can find a component via search or category, add it to
  the canvas, and edit one of its fields in the inspector without leaving the canvas.
- **SC-002**: In chat mode, an applied turn updates the visible workflow without a full-page
  navigation, and a hand-arranged node position survives a subsequent chat turn.
- **SC-003**: Every redesigned surface (three doors, three mode surfaces, flow page, run page) has
  a completed browser-walk row in the feature's evidence.
- **SC-004**: The project gate set is green at the end of the feature: typecheck 0 · package tests ·
  `ui-honesty-check.sh` 0 FAIL · `scenarios:verify` 13/13 · `e2e:ui` at two periods.
- **SC-005**: No functional regression — the acceptance scenarios of the prior rework (three doors,
  chat first-message routing, ref-mapping refusal, armed-vs-draft banner) still pass after the
  redesign.
- **SC-006**: The three mode surfaces use a single typography scale and spacing rhythm, verifiable
  by a shared design-language checklist rather than by inspection.

## Assumptions

- This is a **presentation-only** redesign: no new backend endpoints, no new data, no new
  migrations. The function of the three modes is already built and is preserved unchanged (FR-008).
- The existing dual palette (dark blue-black base and earthy light) is settled and is **not**
  reopened; the redesign changes layout, structure, typography, spacing, components, effects and
  behaviour, and reuses the existing tokens.
- The three build types map to the reference products as follows: **chat → Langdock**, **template →
  StackAI**, **manual builder → Langflow**. These are inspirations for structure and composition,
  not pixel-clones; the surfaces are built from Foundry's existing tokens and UI primitives.
- Scope is the automation creation surfaces (`/flows/new` — the three doors and the chat, template
  and manual-builder surfaces) plus the flow detail (`/flows/[id]`) and run detail (`/runs/[id]`)
  pages. Dashboard, history, organisation and admin pages remain out of scope (consistent with the
  prior decision of 2026-08-12).
- Browser walks are the verification mechanism for visual work: nothing in this repository has been
  seen rendered by a human, so each redesigned surface owns a walk of that surface.
