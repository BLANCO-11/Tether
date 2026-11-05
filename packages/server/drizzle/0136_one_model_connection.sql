-- One model connection (2026-11-04): the builder's enabled models and default (generation_llm) are merged into the one
-- connection (runtime_model_provider). generation_llm is left in place and no longer read. Safe to run twice; only text entries are kept,
-- as mergeModelLists does.
INSERT INTO "runtime_model_provider" ("id", "base_url", "api_key_enc", "default_model", "allowed_models", "updated_at", "updated_by")
SELECT 1, '', NULL, '', '[]'::jsonb, now(), 'migration 0136'
FROM "generation_llm"
LIMIT 1
ON CONFLICT ("id") DO NOTHING;
--> statement-breakpoint
UPDATE "runtime_model_provider" r
SET
  "default_model" = CASE
    WHEN btrim(r."default_model") <> '' THEN btrim(r."default_model")
    ELSE btrim(coalesce(g."default_model", ''))
  END,
  "allowed_models" = (
    SELECT COALESCE(jsonb_agg(to_jsonb(m.item) ORDER BY m.pos), '[]'::jsonb)
    FROM (
      SELECT u.item, MIN(u.pos) AS pos
      FROM (
        SELECT btrim(e.value #>> '{}') AS item, e.ord AS pos
        FROM jsonb_array_elements(
          CASE WHEN jsonb_typeof(r."allowed_models") = 'array' THEN r."allowed_models" ELSE '[]'::jsonb END
        ) WITH ORDINALITY AS e(value, ord)
        WHERE jsonb_typeof(e.value) = 'string'
        UNION ALL
        SELECT btrim(e2.value #>> '{}') AS item, 1000000 + e2.ord AS pos
        FROM jsonb_array_elements(g.allowed) WITH ORDINALITY AS e2(value, ord)
        WHERE jsonb_typeof(e2.value) = 'string'
        UNION ALL
        SELECT btrim(CASE
          WHEN btrim(r."default_model") <> '' THEN btrim(r."default_model")
          ELSE btrim(coalesce(g."default_model", ''))
        END) AS item, 2000000 AS pos
      ) u
      WHERE u.item IS NOT NULL AND u.item <> ''
      GROUP BY u.item
    ) m
  )
FROM (
  SELECT "default_model", CASE WHEN jsonb_typeof("allowed_models") = 'array' THEN "allowed_models" ELSE '[]'::jsonb END AS allowed
  FROM "generation_llm"
  LIMIT 1
) g
WHERE r."id" = 1;
