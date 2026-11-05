-- Tags a datasource's OWNER declares on its table and view columns (builder-stability 2026-10-02, P5-I11).
-- A Postgres schema declares a column's tag as a comment (`foundry:tag=email`); a SQLite schema cannot, so no SQLite column
-- could ever be an address and no per-person send over one could be built. The owner states it here instead — the same
-- vocabulary and checks as a named query's `column_tags`. Keyed `[schema.]table.column`. Declared, never inferred; a
-- declaration fills a silence and never contradicts the schema's own tag. Applied at every schema refresh.
alter table datasources add column if not exists column_tags jsonb not null default '{}'::jsonb;
