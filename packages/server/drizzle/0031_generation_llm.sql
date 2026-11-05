-- The model that DESIGNS automations, settable without a redeploy.
-- `docs/programmes/breaking-2026-08-07/plan-provider-and-scope.md` Part A · F2
--
-- ── ⚠ WHY THIS IS NOT ops-api's `llm_provider` ROW ──────────────────────────
--
-- Reported: *"I changed to 5.4-mini for better speed and it is still slow."*
-- Measured — the runtime provider row said `gpt-5.4-mini` and generation carried
-- on running `google/gemma-4-26B-A4B-it`, because `/ai-provider` configures the
-- `llm_complete` TOOL and nothing else. The generation model was settable only
-- by editing `.env` and running `docker compose up -d` (⚠ not `restart`, which
-- reuses the old environment).
--
-- The obvious fix is one row for both. It is refused by D-35: *"runtime and
-- generation inference must not be merged — different credentials, different
-- processes, no shared abstraction."* That separation was forced by I-24, where
-- the agent-runtime transport silently destroyed the `insufficient_contract`
-- refusal channel — the mitigation for the measured `period="2023-10"` failure
-- this whole migration exists to fix. A shared row is that merge by another
-- road: two consumers, one config, and the next person to "simplify" them has a
-- table saying they are the same thing.
--
-- So: two rows, two stores, two processes. This one lives in `foundry_parent`,
-- which the parent already owns.
--
-- ── ⚠ AND WHY IT HOLDS NO URL AND NO KEY ────────────────────────────────────
--
-- Decided 2026-08-07: the two paths share a GATEWAY, not a CREDENTIAL. The
-- reading that would have put `base_url`/`api_key` here is *"the parent fetches
-- them from ops-api's row"* — and a parent that asks the tool layer for the
-- credential it designs flows with has inverted the boundary the whole of
-- Stage 5 exists to draw: ops-api holds no control-plane credential and the
-- parent holds no ops database credential.
--
-- Endpoint and key therefore stay in `config.inference` (`LLM_BASE_URL` /
-- `LLM_API_KEY`), read in `config/index.ts` and nowhere else — a property
-- `kestra:check` asserts. Only the MODEL becomes configurable here.
--
-- ⚠ **The cost, stated rather than discovered:** the two endpoints can now
-- diverge, because the runtime one is editable from the page and this one is
-- not. `/ai-provider` shows both side by side and says when they differ. A
-- nullable `base_url` override would buy that back cheaply and was DELIBERATELY
-- NOT BUILT, because it re-opens the decision above.
--
-- ── One row, and the constraint that keeps it one ───────────────────────────
--
-- `id boolean PRIMARY KEY DEFAULT true CHECK (id)` — the standard singleton
-- shape. A second row is refused by the database rather than by a convention in
-- a service, because the failure mode of the convention is two configurations
-- where a reader takes whichever it sorted first.
--
-- ⚠ **Absent means "use the environment", and that is not the same as empty.**
-- No row ⇒ `config.inference.model`, which is today's behaviour exactly. A row
-- with an empty `default_model` is refused at write time; it would otherwise be
-- a configuration that says "generate with the model called nothing".

CREATE TABLE IF NOT EXISTS "generation_llm" (
  "id" boolean PRIMARY KEY DEFAULT true NOT NULL,
  "default_model" text NOT NULL,
  -- What the picker offers. Not a spend control the way the runtime allowlist
  -- is — nothing here bills per flow — but the same shape, so the page can be
  -- read the same way, and it keeps a typo from becoming a 404 discovered
  -- minutes later as a failed draft.
  "allowed_models" jsonb DEFAULT '[]'::jsonb NOT NULL,
  "updated_at" timestamptz DEFAULT now() NOT NULL,
  -- The signed identity's subject. NULL only for a row written before there was
  -- one, which nothing can currently produce — kept nullable rather than
  -- defaulting to a plausible name, the rule 0026/0029/0030 all follow.
  "updated_by" text,
  CONSTRAINT "generation_llm_single_row" CHECK ("id")
);
