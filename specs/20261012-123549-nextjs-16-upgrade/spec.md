# Feature Specification: Upgrade the web client's framework to the current major release

**Feature Branch**: `20261012-123549-nextjs-16-upgrade`

**Created**: 2026-10-12

**Status**: Draft

**Input**: User description: "Upgrade the Next.js client (packages/client) from 14.2.35 to the latest release (16.4.0) via a two-hop path (14→15→16), keeping React at 18.3.1 until both hops pass, with an optional separate React 19 step, without regressing any user-visible functionality."

## Background

The web client runs on a framework release two majors behind current. The upgrade changes behaviour in places this product depends on for safety, not just appearance: how a page learns which record it is showing, how the server-side sign-in gate is declared, how the browser's calls reach the API (the one route holding the deployment's root credential), and how the build is produced. The client's automated tests render pages with their data layer stalled, so they cannot see most of these regressions. The upgrade is therefore delivered as a **sequence of independently verified phases**, each of which can be reverted on its own.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - A recorded baseline and a net that can actually fail (Priority: P1)

Before any dependency moves, the team has a recorded "known good" state of the client and a set of checks that would turn red if the upgrade broke the behaviours listed in this spec. Without this, a green result after the upgrade proves nothing.

**Why this priority**: Every later story is judged against it. The existing render tests cannot detect a wrong record id, a broken redirect or a broken credential-bearing route, so the upgrade would otherwise be verified by hope.

**Independent Test**: On the unmodified code, record the baseline results; then run each new check against deliberately broken code (for example, a route that reads its path segments the wrong way) and confirm each one fails. Can be fully tested without upgrading anything.

**Acceptance Scenarios**:

1. **Given** the client before any change, **When** the baseline is recorded, **Then** it contains the type-check result, the full client test count and pass state, the UI honesty check result, and the production build's exit status and warnings, all saved where later phases can compare against them.
2. **Given** the new checks for record-id handling, sign-in-page parameters, the API proxy route and the sign-in gate, **When** each is run against code that mishandles the thing it covers, **Then** it fails (each check is proven able to fail).
3. **Given** the manual smoke script, **When** a person follows it on the baseline, **Then** every step passes and the steps cover sign-in, session expiry, opening a workflow, the builder canvas, a run, approvals, members, audit and data sources.

---

### User Story 2 - The first hop keeps every record page and the API proxy working (Priority: P1)

After moving to the intermediate release, a signed-in person can open any workflow, run, resource, approval or data source by its link and see the right record, and every action in the app that goes through the API proxy still works and is still bound by the same refusals.

**Why this priority**: This is the change most likely to break the whole product at once: the proxy carries every browser request, and the record pages read their id from the address.

**Independent Test**: Run Phase 1 checks plus the smoke script; open each record page by direct link and by in-app navigation.

**Acceptance Scenarios**:

1. **Given** a signed-in person and a valid link to a workflow, run, resource, impact report, approval or data source, **When** the page opens, **Then** it shows that record, not an empty or "not found" state.
2. **Given** a request through the API proxy for a path the proxy forbids (the oracle, the engine step callbacks, the execution callbacks, real email delivery), **When** it is made, **Then** it is refused exactly as before, and an unsigned request is answered with an authentication refusal in the API's own format rather than a page redirect.
3. **Given** a sign-in link carrying a return address or an "expired" marker, **When** the sign-in page opens, **Then** the return address is honoured only if it is a safe in-app address, and an expired session shows the sign-in page instead of bouncing the person back into a page whose requests are all refused.
4. **Given** the nine pages that read their filters, tabs or views from the address bar, **When** each is opened directly with those parameters, **Then** it opens with the same view, and the production build completes without warnings about them.

---

### User Story 3 - The second hop keeps the sign-in gate closed (Priority: P1)

After moving to the current release, no page and no API path is reachable without a valid session, a signed-in person is still moved off the sign-in page, and session identity (and therefore workspace membership, which is keyed on it) is unchanged.

**Why this priority**: A silent mismatch here would leave every page open or lock everyone out, and nothing would look broken to a developer who is already signed in.

**Independent Test**: Request every kind of path with no session, with a valid session and with an expired one, against the built application (not the dev server), and compare to the baseline's answers.

**Acceptance Scenarios**:

1. **Given** no session, **When** any application page is requested, **Then** the person is sent to sign-in with the original address preserved as the return address.
2. **Given** no session, **When** any API path is requested, **Then** the answer is an authentication refusal in the API format, never a redirect or a page.
3. **Given** a valid session, **When** the sign-in page is requested, **Then** the person is sent into the app, except when the "expired" marker is present.
4. **Given** a person who signed in before and after the upgrade, **When** their identity is compared, **Then** the stable subject is identical, so their existing workspace memberships still apply.
5. **Given** the framework's own assets and the authentication endpoints, **When** requested without a session, **Then** they are served as before (the gate excludes them exactly as it did).

---

### User Story 4 - The build, the redirects and the shipped image behave the same (Priority: P2)

The production build looks the same, the old links still redirect to the same places with the same permanence, the release version still appears beside "Beta", and the container image still builds and starts.

**Why this priority**: These are silent-failure areas: a missing stylesheet rule, font or version label does not raise an error, and the image copies only a fixed set of build outputs.

**Independent Test**: Build both ways the new release supports (its default bundler and the alternative) and compare; build the image from a clean checkout and start it.

**Acceptance Scenarios**:

1. **Given** the built application, **When** the old paths (`/home`, `/workflows` and its sub-paths, `/runs`, `/create` and its sub-paths, and the two template bookmarks) are requested, **Then** each lands on the same destination with the same temporary or permanent status as before, and the two template bookmarks still match before the wildcard rules.
2. **Given** the built application, **When** any page is opened, **Then** styling, the two bundled font families and the canvas styles are present, and the release version label shows the root package's version.
3. **Given** a clean checkout, **When** the client image is built and started, **Then** it serves the sign-in page on its usual port with no files missing from the image.
4. **Given** the `lint` script, **When** it is run, **Then** it either does what it says or is removed; it does not exist in a state where it fails because the underlying command was dropped.

---

### User Story 5 - The workflow canvas is unchanged under the newer UI library (Priority: P3, optional phase)

If the UI library is also moved to its next major release, the canvas that draws workflows keeps its measured behaviour: edges stay drawn while hovering, node sizes stay true to what is declared, and layout is not recomputed when a node is clicked.

**Why this priority**: It is the largest and most behaviour-dense component and its earlier flicker fixes depended on subtle rendering details. It is independent of the framework upgrade, so it is a separate, optional phase, taken only after the two framework hops are green.

**Independent Test**: Run the canvas tests and open the builder and a run page, hover nodes, click nodes and edit.

**Acceptance Scenarios**:

1. **Given** a workflow on the canvas, **When** the pointer enters and leaves nodes repeatedly, **Then** no edge disappears.
2. **Given** an editable canvas, **When** a node is clicked, **Then** the layout does not recompute and the details panel opens.
3. **Given** the full client test suite, **When** run after the UI library move, **Then** it has the same count and the same pass state as the baseline.

---

### Edge Cases

- A record page is opened with its id in the address but the record was deleted: the page must still say the record no longer exists, not show a blank state caused by a missing id.
- A record page is rendered by a test with no id supplied (one page already tolerates this): it must keep rendering.
- A sign-in link with an unsafe return address (another site, or a path that is not in the app): it must be ignored as before.
- The session ends while a page is open: the next request gets the authentication refusal and the app sends the person to sign-in with the expired marker, as before.
- An API request whose path contains the forbidden segment in a different case or position: the refusal must be unchanged.
- A page that uses address-bar parameters is rendered during the build with no request: it must not fail the build.
- The build is run on a machine without network access: the version label still resolves from the root package file.
- A phase fails its gate: the team returns to the previous phase's commit rather than patching forward.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: Before any dependency changes, a baseline MUST be recorded: type-check result, the number of client test files and tests and their pass state, the UI honesty check result, and the production build's exit status and warnings.
- **FR-002**: Each new check required by this spec (record-id handling on each record page, sign-in-page parameters, the API proxy route including its deny list, the sign-in gate) MUST be shown to fail against deliberately broken code before it is relied on.
- **FR-003**: A manual smoke script MUST exist and cover sign-in (local credentials, and the identity-provider path where a test tenant exists), session expiry, opening a workflow, the builder canvas, a run, the API proxy, approvals, members, audit and data sources.
- **FR-004**: The upgrade MUST proceed in phases: (1) the intermediate release, (2) the latest release, (3) optionally the UI library's next major. Each phase MUST pass the same gate before the next begins and MUST be a separate, revertable commit.
- **FR-005**: The UI library MUST NOT change in phases 1 and 2.
- **FR-006**: Every record page that reads an id from its address (workflows, builder, runs, resources, impact report, approvals, data sources) MUST show the correct record after the upgrade, for both direct links and in-app navigation.
- **FR-007**: The sign-in page MUST continue to honour the return address and the expired marker, with the return address restricted to safe in-app addresses.
- **FR-008**: The API proxy route MUST continue to (a) refuse unsigned requests itself with the API-format authentication refusal, not only through the gate, (b) refuse the documented forbidden path segments, and (c) forward every other path with the deployment credential and the signed identity, unchanged.
- **FR-009**: The nine pages that read filters, tabs or views from the address bar MUST open with the same view as before and MUST NOT cause build warnings or failures.
- **FR-010**: The server-side sign-in gate MUST keep its exact behaviour: redirect unsigned page requests to sign-in with the return address; answer unsigned API requests with the authentication refusal; send signed-in people off the sign-in page except when the expired marker is present; leave authentication endpoints and framework assets reachable.
- **FR-011**: The gate MUST be re-declared in whatever form the latest release requires and the old form MUST NOT remain, so there is exactly one gate.
- **FR-012**: A person's stable identity subject MUST be identical before and after the upgrade, so memberships keyed on it keep applying.
- **FR-013**: Every legacy path redirect MUST resolve to the same destination with the same temporary or permanent status, and the template bookmarks MUST still take precedence over the wildcard rules.
- **FR-014**: The release version label MUST still show the root package's version in the built application.
- **FR-015**: Styling, the two bundled font families and the canvas styles MUST be present in the built application for every build mode the latest release supports and the team uses.
- **FR-016**: The client container image MUST build from a clean checkout and start, serving the sign-in page on its usual port, with the lockfile and install working non-interactively.
- **FR-017**: The `lint` script MUST NOT be left failing because its underlying command was removed; it MUST be removed or replaced by a working equivalent as an explicit decision recorded in the plan.
- **FR-018**: Comments, repository documentation and checks that describe the old release or the old gate file (including the comment forbidding the newer params form, and any check that names the gate file) MUST be updated in the same change so none states something false.
- **FR-019**: A failed gate MUST be resolved by reverting to the previous phase's commit.
- **FR-020**: No server package, database schema, API route or workflow behaviour is changed by this feature.

### Key Entities

- **Baseline record**: the saved results of the type-check, test suite, honesty check and build before any change; later phases are compared to it.
- **Phase gate**: the fixed set of checks (type-check, full client test suite, honesty check, production build, smoke script, image build) a phase must pass before the next begins.
- **Smoke script**: the ordered manual steps that cover what automated checks cannot see.
- **Sign-in gate**: the single server-side control deciding whether a request reaches a page or an API path.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: After each phase, 100% of the baseline's client tests that passed still pass, and the number of tests is not lower than the baseline's.
- **SC-002**: Every record page (7 kinds) opens the correct record from a direct link in 100% of smoke-script runs, and none shows an empty state caused by a missing id.
- **SC-003**: Across a request matrix covering every page kind and an API path, each with no session, a valid session and an expired session, 100% of answers match the baseline's (redirect, refusal or page).
- **SC-004**: 0 requests reach the API without the sign-in check on both the gate and the proxy route; each of the 4 forbidden path segments is still refused.
- **SC-005**: A person who signed in before the upgrade keeps all their workspace memberships afterwards with no re-assignment.
- **SC-006**: The production build completes with 0 new errors and 0 new warnings relative to the baseline, and the client image builds and starts from a clean checkout.
- **SC-007**: All legacy links (every redirect rule) resolve to the baseline's destination and status.
- **SC-008**: A person following the smoke script completes it end to end in the latest release with no step failing or behaving differently from the baseline.
- **SC-009**: Every new check is demonstrated to fail on broken code at least once before the upgrade begins (no check that cannot fail).

## Assumptions

- "Latest" means the newest stable release at the time work starts; it was 16.4.0 when this spec was written and the plan will re-confirm it.
- The two-hop order (14 → 15 → 16) is kept so that failures can be attributed to one set of changes.
- The UI library move is optional and last; the latest framework release accepts the current UI library version, so it is not required.
- The authentication library's newest beta supports the latest release; if it does not, the plan records a decision before phase 2.
- Node 22 remains the supported runtime and already satisfies the latest release's minimum.
- Server packages are untouched, so the existing server test suite is not part of the gate.
- The client has no linting configuration today; adding one is out of scope unless the plan decides it is the replacement for the removed command.
- A test tenant for the identity-provider sign-in may not exist; if not, that path is verified by the credentials path plus a review of the unchanged configuration, and the gap is stated in the smoke script.
- Performance, new features and visual redesign are out of scope; the success measure is "nothing a person could do before has stopped working".
