# Tasks: SSRF and Egress Policy (Surface D)

**Feature**: `specs/20260804-080708-ssrf-egress-policy` | **Branch**: `krt/guardrail_validation`

**Inputs**: [spec.md](spec.md), [plan.md](plan.md), [research.md](research.md),
[data-model.md](data-model.md), [contracts/egress-policy.md](contracts/egress-policy.md),
[quickstart.md](quickstart.md)

**Tests are required** (Article II, and this is a security control). Contract IDs
(C1…, S1…, D1…, P1…, L1…, R1…, X1…) refer to `contracts/egress-policy.md`.

**Do not add the `network` boolean→enum change.** The roadmap lists it under V6;
it is a breaking API change and belongs in its own PR. `routes/scripts.ts:166`
preserves the boolean semantics on purpose. This note is here because it is the
most likely thing for an implementer to add helpfully.

---

## Phase 1: Setup and survey

- [X] T001 Record the pre-feature baseline in `specs/20260804-080708-ssrf-egress-policy/notes.md`: `pnpm -r typecheck` and the three package test counts. FR-021 / X2 is checked against this.
- [X] T002 Survey the live `triggers.config` rows for the distinct keys present, and grep the codebase for every key actually read. Record both lists in `notes.md`. D6 narrows this field from `z.record(z.any())`, and "nothing uses that key" asserted from memory is how a working integration breaks.
- [X] T003 **Verify the socket hook per client before designing around it** (research R1): confirm against the installed `pg` 8.13.x, `mysql2` 3.23.x and Node ≥20 whether a custom `lookup` reaches the socket for each. Record the exact option name and shape per client in `notes.md`. If one does not expose it, record that the research R1 contingency applies to that path — the whole design rests on this and it must not be assumed.
- [X] T004 Record in `notes.md` the deployment's reserved-range dependencies from research F3 — `stubPublicBase`, `dbHostForScripts`, the Tether base — with their current values. These are what the permitted-internal default must derive from (**P3**).

---

## Phase 2: Foundational — the policy module (slice 1)

**Blocks everything.** Pure, no I/O, exhaustively testable.

- [X] T005 [P] Write `foundry/packages/server/src/egress/policy.test.ts` for **C1–C8** as a data-driven classification table from research R4: loopback, private v4, link-local v4 and v6, CGNAT, unique-local, unspecified, public.
- [X] T006 [P] Same file, **C7** as its own named test: `::ffff:169.254.169.254` classifies as reserved. It gets its own test rather than a table row because a dotted-quad-only implementation passes every other row and fails this one.
- [X] T007 [P] Same file, **S5**: decimal, octal and hex IP literals are classified by what they denote, not by their spelling.
- [X] T008 [P] Same file, **P1** and **P2**: a permitted `host:port` is allowed despite being reserved; permitting `host:4000` does **not** permit `host:5432`.
- [X] T009 [P] Same file, **C9**: classification performs no DNS, no socket and no clock call.
- [X] T010 Write `foundry/packages/server/src/egress/policy.ts` — `classify(address)`, the scheme allowlist, the permitted-internal parser, and `decide()` returning the four-reason shape from data-model.md. **No I/O in this file** (**C9**); that is what keeps the encoding cases testable without a resolver.
- [X] T011 Add the permitted-internal configuration to `foundry/packages/server/src/config/index.ts`, **derived by default** from `stubPublicBase`, `dbHostForScripts` and the Tether base (**P3**, research R3) rather than hardcoded literals — a hardcoded default that disagrees with a customised value blocks the deployment's own services.
- [X] T012 Add the new variable to `.env.example` with a placeholder and a comment saying what it is for (FR-003, Article VIII).
- [X] T013 Run `pnpm --filter @foundry/server test`. T005–T009 green. Nothing is wired yet. **62 tests.**

---

## Phase 3: Foundational — the validating lookup (slice 2)

- [X] T014 [P] Write `foundry/packages/server/src/egress/lookup.test.ts` against a **stubbed resolver**: a host resolving only to public addresses passes through.
- [X] T015 [P] Same file, **D2**: a host resolving to one public and one reserved address is refused. Permitting on the first acceptable address is a one-DNS-record bypass, and this is the only test that catches it. *(Both orderings tested — reserved-first and public-first.)*
- [X] T016 [P] Same file, **D1 — the rebinding test**: the stubbed resolver returns public on the first call and reserved on the second; the second connect is refused. This is the single most important test in the feature — it is what separates this design from a check that looks right and loses the race. *(Plus a companion asserting the lookup caches nothing, since a cache would reopen the window it closes.)*
- [X] T017 Write `foundry/packages/server/src/egress/lookup.ts` — a `dns.lookup`-shaped function that resolves, checks **every** returned address against the policy, and either passes it through or errors with the policy reason attached so the caller can log it distinctly (**D6**).
- [X] T018 Write `foundry/packages/server/src/egress/agent.ts` — **plus two things the task list did not anticipate, both in `notes.md`: Node skips `lookup` entirely for an IP literal (so the lookup alone left `http://169.254.169.254/` unguarded — found by a real-socket test, fixed with a literal check in `createConnection`), and `keepAlive` had to be forced off because a pooled socket reuses an address without re-resolving.** Original text: — an `http`/`https` `Agent` whose `createConnection` uses the lookup (D2 in plan.md). Note in a comment that this path **does not follow redirects**, which is why **D4** holds, so that a future change back to `fetch` is recognisably a security regression rather than a refactor.
- [X] T019 Run the server suite. **83 tests across the three `egress/` files**, including `agent.test.ts` which opens real sockets — that is what caught the IP-literal gap.

---

## Phase 4: User Story 1a — the poll path (slice 3, the live exposure)

**Goal**: the parent stops dialling arbitrary addresses on a 20-second timer.

- [X] T020 [P] [US1] Write `foundry/packages/server/src/validation/schemas/trigger.schema.test.ts` for **S1, S2, S5** and **S8**. **S3 and S4 are deliberately NOT enforced at registration** — see the deviation note below.
- [X] T021 [P] [US1] Same file, FR-021: every trigger config key found in T002 still round-trips. Includes the live `Mailbox` key by name.
- [X] T022 [US1] Write `foundry/packages/server/src/services/trigger-scheduler.egress.test.ts` for **D5**: drive a tick with a refused URL and assert **no socket is opened** — asserted at a real destination server, not by trusting a mock.
- [X] T023 [US1] Same file, **D6**: a policy refusal logs distinguishably from a timeout.
- [X] T024 [US1] Same file, **D4**: a permitted host that 302s to a reserved address does not reach it. Kept deliberately although it cannot currently fail.
- [X] T025 [US1] Same file, **X3**: a pre-existing trigger with a now-refused URL stays `enabled`; the condition is surfaced, nothing auto-disables.
- [X] T026 [US1] Replace `config: z.record(z.any())` in `trigger.schema.ts`. **Only the `poll` arm is strict** — `webhook` and `manual` passthrough, because T002 found a live `Mailbox` key a strict union would have 400'd. Narrow where the dial is; preserve elsewhere.
- [X] T027 [US1] Replace `fetch(cfg.url)` in `trigger-scheduler.ts` with `http(s).request` through the egress agent.
- [X] T028 [US1] Split the scheduler's poll `catch` so a policy refusal is logged as a refusal and a network error as a network error.
- [X] T029 [US1] Surface the refusal on the trigger's public shape. Closed in slice 6: `toPublicDetailed()` now reads `lastEgressRefusalFor()` for poll triggers, `null` for every other type. `trigger-egress-surface.test.ts` proves it's wired (not just present) and proves **X3 holds structurally**: `enableBlockedBy` is never derived from the egress diagnostic — a fixture whose script is in draft is still refused for `script_status`, and the audit-gate reason is unaffected by an egress refusal existing alongside it.
- [X] T030 [US1] Run the full server suite and `pnpm -r typecheck`. **835 passed / 23 skipped, typecheck clean, zero pre-existing failures.**

### Deviation recorded at T020 — S3 and S4 are not registration-time checks

`contracts/egress-policy.md` **S3** and **S4** ask for a hostname that *resolves*
to a reserved address, and an unresolvable hostname, to be refused **at
registration**. They are not, and this is a decision rather than an omission:

- Refusing at registration on what a name resolves to *now* is security theatre —
  the answer can change before the dial, which is the entire premise of D1. The
  dial-time lookup refuses both cases correctly and is tested for both.
- Refusing registration when a host is momentarily unresolvable would reject a
  legitimate URL because DNS blinked.

The cost is real and worth stating: an operator registering a hostname that
resolves internally is told at the first tick rather than at submit time. If that
trade is unacceptable, the fix is an **advisory** resolution at registration that
warns without blocking — not a refusal, and not in the zod schema, which is
synchronous.

**Checkpoint**: the exploitable path is closed. This slice is worth shipping alone.

---

## Phase 5: User Story 1b — the datasource path (slice 4)

- [X] T031 [P] [US1] Write `foundry/packages/server/src/validation/schemas/datasource.schema.test.ts` for **S6**: a reserved-host connection string is refused at registration, with the reason distinguishable.
- [X] T032 [P] [US1] Write `foundry/packages/server/src/services/introspect/postgres.egress.test.ts` for **D5** on the Postgres driver. Drives pg's actual positional `connect(port, host)` against a real listener.
- [X] T033 [P] [US1] Write `foundry/packages/server/src/services/introspect/mysql.egress.test.ts` for **D5** on the MySQL driver. Two tests, not one — and T003 proved the point: the two `stream` contracts are *opposite*, so a shared factory fails silently rather than loudly. Includes a contract test pinning that mysql2's factory returns an already-connecting socket.
- [X] T034 [US1] Write a test for **X1**. Greps the serialised issue list for the password, the username and the DSN scheme.
- [X] T035 [US1] Add connection-string host validation to `datasource.schema.ts` — on **update** as well as create, so update is not a second write path.
- [X] T036 [US1] Wire the lookup into `postgres.introspector.ts` via `pgStreamFactory`.
- [X] T037 [US1] Wire the lookup into `mysql.introspector.ts` via `mysqlStreamFactory` and the `uri` config form.
- [X] T038 [US1] Verify **D3** per driver. **All three paths achieve true dial-time checking; the R1 contingency was used nowhere.** Recorded in `notes.md`, and the standards amendment may claim it without qualification for parent-side egress.
- [X] T039 [US1] Run `pnpm --filter @foundry/server demo:seed` with the policy active (**P4**). Passes — 7 tables introspected *through* the new dial path. **This is also what caught FINDING 3**: the derived default was missing `DATABASE_URL`, so the policy refused the parent's own database.

---

## Phase 6: User Story 2 and 4 — tool URLs and the runtime URL (slice 5)

- [X] T040 [P] [US2] Write a test for **S7**: a tool registered with a reserved-address URL is refused, even though the parent never dials it — it reaches the model in the manifest and is dialled by generated code.
- [X] T041 [P] [US2] Write a test for **P5**: dummy-tool stub URLs remain reachable. The stub base is reserved-range by design, so this catches an exception list written for the database but not the stubs.
- [X] T042 [US2] Add the reserved-address refusal to `tool.schema.ts`, alongside the existing `^https?://` check, on create AND update.
- [X] T043 [P] [US4] Write a test for **R1**, **R2** and **R3**.
- [X] T044 [US4] Add `tetherBaseUrlConcern()` to `config/index.ts`, wired into `index.ts` so a fatal concern actually refuses startup.
- [X] T045 [US2] Run the server and client suites and `pnpm -r typecheck`. **873 passed / 23 skipped.**

---

## Phase 7: User Story 3 — R12, least privilege (slice 6)

- [X] T046 [US3] Research and record in `notes.md` the exact per-engine privilege query. **Postgres**: superuser check, then table-level INSERT/UPDATE/DELETE via `has_table_privilege`, then schema `CREATE` (the `public`-default-grant trap `demo/hr-roles.ts:107-110` documents). **MySQL**: parse `SHOW GRANTS FOR CURRENT_USER()`. No write probe on either.
- [X] T047 [P] [US3] Write `datasource-privilege.test.ts` for **L1**. Proven against the **real local database**, not a mock: row count of `datasources` unchanged before/after, using the owner credential (which is genuinely writable, so the test also confirms the determination is correct while proving the query itself performs no write).
- [X] T048 [P] [US3] Same file, **L6**: the injected-runner unit test structurally proves `default_transaction_read_only`/`pg_settings` is never queried, and a role with real write grants is still correctly determined writable.
- [X] T049 [P] [US3] Same file, **L3**: an unsupported engine returns `null`, never `false`.
- [X] T050 [US3] Write a test for **L4** and **L5** — against the live database in `datasource.service.test.ts`, using the real `foundry_ro` role (genuinely read-only) vs. `DATABASE_URL`'s owner credential (genuinely writable) so the distinction is real, not asserted.
- [X] T051 [US3] Add `credentialCanWrite` (nullable boolean) and `credentialCheckedAt` to `db/schema.ts`.
- [X] T052 [US3] Generate the migration (`0013_magenta_mandroid.sql`) and read it before applying: **exactly two `ADD COLUMN`s, nothing else.** No backfill.
- [X] T053 [US3] Write `datasource-privilege.service.ts`: pure per-engine determiners taking an injected query runner (so L1/L6 are unit-testable), plus `determineByConnectionString()` which opens the connection through the same egress-safe `pgStreamFactory`/`mysqlStreamFactory` as introspection — so this check cannot itself be used to dial an address the policy would refuse.
- [X] T054 [US3] Wired into `datasource.service.ts`: **create refuses** a writable credential (L4); **update re-determines but never refuses** (L5) — an existing datasource is never disabled by a credential rotation.
- [X] T055 [US3] Surfaced on `Connection.credential_can_write`/`credential_checked_at` (client `types.ts`), threaded through `connectionFromFA`, rendered on the data-sources detail page: a danger banner for `true`, a quiet confirmation for `false`, **nothing at all for `null`** — L3's rule enforced in the markup, not just the type.
- [ ] T056 [US3] Verify the new UI in a real browser at ~375 / ~768 / ~1280 px per `design.md` §3 (**NON-NEGOTIABLE**). **STILL OPEN**, same cause as V4's T044 and V5's T032: no browser with a layout engine in this environment. `min-w-0 break-words` is applied to both new banners on the pattern V4 established; a mount test (`credential-writable-mount.test.tsx`) proves all three states render distinct, correct markup, including that `null` renders neither banner — that is not a substitute for the layout check.

---

## Phase 8: Hardening and close-out

- [X] T057 **Deletion pass (X4).** For each of the ten wiring points in [quickstart.md](quickstart.md) §6: delete, run the full suite, record CAUGHT/SURVIVED in `notes.md`, revert. Watch two in particular — **point 8** (a lookup checking only the first resolved address passes every single-address test; only **D2** catches it) and **point 7** (if nothing fails when the permitted-internal exception is removed, nothing is testing that the demo still works, and the feature's biggest usability risk is unguarded).
- [X] T058 **Regression (X2).** Re-run T001's commands and compare with the baseline. The only new failures permitted are tests that deliberately encode a new refusal.
- [X] T059 Re-run `pnpm --filter @foundry/server demo:seed` and the demo rehearsal end to end (**P4**, Article XIV). A guardrail that breaks the demo is a guardrail that gets disabled.
- [X] T060 Grep every log line and response body added by this feature for credential exposure (**X1**, FR-014). Connection strings carry passwords and the natural refusal message is exactly where one leaks.
- [X] T061 Record in `notes.md` which paths achieved true dial-time checking via the `lookup` hook and which (if any) fell back to research R1's contingency. This determines what the standards amendment may claim.
- [X] T062 Correct `docs/validation-and-guardrails-roadmap.md` §V6: the sharpest exposure is the **poll-trigger `fetch`** and the **datasource connection string**, not tool URLs — the parent never dials a tool URL. Record that the `network` enum was split out as its own feature and why.
- [X] T063 Run `/speckit-comply`. **Verify each `[X]` above individually rather than in bulk** — V2's comply found three tasks marked complete whose tests were never written, and V3 and V4 each found more. Resolve CRITICAL and HIGH findings first. **FAIL — one HIGH finding (T067).**
- [X] T067 **Comply remediation (HIGH).** `updateTriggerSchema` validates `config` against `configFor(type)` where `type` comes from the *request body*, not the stored row (`trigger.schema.ts:68-90`). A PATCH that changes only `config.url` on an existing `poll` trigger without resending `type` skips `zPollUrl`'s S1/S2 check entirely — `parseConfigForType(type, config)` (`trigger.schema.ts:119`) was written for exactly this but is never called from `trigger.service.ts:update()` or `routes/triggers.ts`. Fix: in `trigger.service.ts:update()`, load the current trigger, call `parseConfigForType(current.type, input.config)` when `input.config !== undefined`, and reject (400) on failure before calling `triggerRepo.update`. Add a test PATCHing only `config.url` on a stored poll trigger with a reserved-range URL and no `type` in the body, asserting 400. Dial-time `lookup` policy (D1/D2) still refuses the connection either way, so this closes the registration-time UX gap, not a live SSRF hole.
- [ ] T064 Commit each slice separately on `krt/guardrail_validation`, only when green. **The user drives git manually — do not commit without being asked.**
- [ ] T065 *(after merge)* `/speckit-update-standards`: **R8** closes with its scope stated (parent-side egress guarded; container egress named as the follow-up); **R12** moves to "detected and surfaced, refused for new registrations" and **does not close**; **R14** closes; §5's trusted-admin claim narrows rather than disappears.
- [ ] T066 *(after merge)* Open the follow-up feature for the container egress policy and the `network` boolean→enum change, so the deferral is a scheduled item rather than a dropped one.

---

## Dependencies

```
Phase 1 (survey)
   ↓
Phase 2 (policy module) ── Phase 3 (lookup)
                                ↓
                    Phase 4 (poll path — the live exposure)
                                ↓
                    Phase 5 (datasource path)
                                ↓
                Phase 6 (tool URLs + R14)   Phase 7 (R12)
                                ↓
                          Phase 8 (hardening)
```

Phases 6 and 7 are independent of each other and can proceed in either order once
Phase 5 lands.

## Parallel opportunities

- T005–T009 (one file, independent cases)
- T014–T016 (one file, independent cases)
- T031–T033 (three separate test files)
- T040/T041/T043 (independent surfaces)
- T047–T049 (one file, independent cases)

## MVP scope

**Phases 1–4.** The policy, the lookup, and the poll path. That closes the only
remotely exploitable path in the feature — an unvalidated URL fetched by the
parent every 20 seconds with a change-detection oracle attached — and it is worth
shipping before the rest is written.
