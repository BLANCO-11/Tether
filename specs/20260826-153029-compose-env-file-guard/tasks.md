# Tasks: A build that cannot reach its dependencies says so

**Feature**: `20260826-153029-compose-env-file-guard`

⚠ **THIS FILE IS A BACKFILL RECORD, NOT A PLAN OF WORK.** Every `[X]` below was
completed *before* the task was written — that is what `/speckit-backfill` produces.
The feature's actual work is unstarted and listed at the bottom, unticked.

⚠ **The `[X]` marks do NOT mean this feature is done.** They mean the
`.env.example` edit is now covered by an artifact. Nothing in User Stories 1–3 of
`spec.md` has been built.

---

## Backfilled 2026-08-26 from the working tree (staged, uncommitted)

Source: `git diff --cached .env.example` — 22 insertions, 22 deletions, one file.

- [X] **T-B1** Empty the value of every credential-shaped assignment in
  `.env.example`: `PARENT_API_KEY`, `MCP_BRIDGE_API_KEY`, `DATABASE_URL`,
  `TETHER_API_KEY`, `KESTRA_CALLBACK_SECRET`, `CREDENTIAL_ENC_KEY`, `OPS_API_KEY`,
  `LLM_API_KEY`. Covers FR-B1 for the keys the stated intent names.
  - Files: `.env.example`
- [X] **T-B2** Empty the value of every remaining assignment in `.env.example`:
  `PORT`, `WS_PORT`, `NODE_ENV`, `TETHER_BASE_URL`, `KESTRA_BASE_URL`,
  `KESTRA_NAMESPACE_PREFIX`, `KESTRA_RETENTION_DAYS`, `KESTRA_PURGE_CRON`,
  `KESTRA_FRAGMENT_IMAGE`, `BUDGET_DEFAULT_MAX_CONCURRENT`,
  `BUDGET_DEFAULT_MAX_AGENT_RUNS_PER_DAY`, `LLM_BASE_URL`, `LLM_FAST_MODEL`,
  `LLM_REASONING_MODEL`.
  - Files: `.env.example`
  - ⚠ **[BACKFILLED — verify with author]** These are **not secrets**. The stated
    intent was *"removed all dummy secrets"*, so this task may be wider than
    intended. Recorded as done because it is what the diff does — not because it
    was asked for. See plan.md's open question, options A and B.
- [X] **T-B3** Preserve every key and every explanatory comment. Verified: the
  removed and added key lists are identical, 22 for 22, and no comment line appears
  in the diff.
  - Files: `.env.example`
- [X] **T-B4 (verification, no code)** Confirm no removed value was ever a real
  credential. Every removed line was checked against the repository's own
  `SECRET_CONTENT_PATTERNS` (sourced from `ci/secret-policy.sh`, not a hand-copied
  list): **zero matches**. Removed values were `dev-parent-key`,
  `<your-tether-api-key>`, a loopback DSN with `foundry:foundry`, and
  operational literals. **No rotation is required**, and no history rewrite.
- [X] **T-B5 (verification, no code)** Confirm no runtime or build impact. Searched
  `scripts/`, `ci/`, `infra/`, `.githooks/`, `packages/server/src` for consumers of
  `.env.example`: six hits, **all error-message text**. Compose reads `.env` via
  `env_file`. Nothing parses the example file.

### Follow-ups this backfill opened — NOT done

- [ ] **T-B6** Resolve plan.md's open question (A: restore non-secret defaults, or
  B: keep everything empty and fix the comments that name removed values). Under
  **either**, the header comment *"Host ports form one block: 4000 API, 4001 WS,
  4002 web, 4003 mcp-bridge"* sitting above an empty `PORT=`, and *"Matches
  infra/docker-compose.yml (host port 5433)"* above an empty `DATABASE_URL`, are
  currently false-by-juxtaposition. **Article VII.**
- [ ] **T-B7** ⚠ **Do not expect this change to unblock `git push`.** The push is
  refused over `packages/client/.env.local.example` — a **different file**, rejected
  by a **name** rule (`ci/secret-policy.sh:14` matches `.env.*`; the exemption on
  line 13 lists only `.env.example`, `.env.sample`, `.env.template`). That file is
  a placeholder template, is already on `origin/v1-alpha`, and matched **no**
  content pattern — a confirmed false positive. Fixing it means widening the
  exemption, which touches enforcement machinery and therefore needs its **own**
  spec-kit feature. Not this one.

---

## The feature's own work — NOT STARTED

Needs `/speckit-plan`, then `/speckit-tasks`. Listed here only so the `[X]` marks
above cannot be mistaken for a finished feature.

- [ ] **US1** — the build-time guard: refuse when no CA is requested and public TLS
  cannot validate, before any dependency fetch (FR-001…FR-005).
- [ ] **US2** — the six build-triggering compose invocations missing `--env-file`,
  plus a check that fails on a seventh (FR-006, FR-007).
- [ ] **US3** — preserve the un-intercepted build path (FR-003), measured with
  `specs/20260824-211547-docker-ca-trust/verify-fr003.sh`.
