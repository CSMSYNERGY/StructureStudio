-- 336_brand_colors.sql — a builder's own brand palette, reusable everywhere a color is picked.
--
-- ⛔ APPLY BY HAND, AFTER A HUMAN HAS READ IT. Pipe this file to `supabase db query --linked`
--    (stdin; NOT `--file`, see 270's header), then record it:
--      insert into supabase_migrations.schema_migrations (version, name) values ('336', '336_brand_colors') returning version, name;
--    NEVER `supabase db push`. The file carries its own begin;/commit;.
--
-- ── WHY (Carolyn 2026-10-25) ─────────────────────────────────────────────────────────────
-- "In the company settings I want to be able to add additional brand colors and then those
-- colors to show in the forms as easy selections and also to show in the email as easy
-- selection."
--
-- Branding already holds TWO colors — accent_color and header_bg — and they are the designer's,
-- not a palette: there is nowhere to keep the other four a brand actually uses. This adds the
-- rest of the palette beside them, and the form designer and the email editor read it as
-- one-click swatches. Nothing here replaces accent_color: that column stays the designer's
-- accent, and the palette is additive.
--
-- ── SHAPE ────────────────────────────────────────────────────────────────────────────────
-- A jsonb ARRAY of {"name": "...", "hex": "#RRGGBB"} objects, in the order the builder put
-- them in. An array, not an object keyed by name, because the ORDER is the point — swatches
-- are drawn left to right as they were arranged — and two colors may share a blank name.
--
-- Whitelist-rebuilt on every save in portal-settings (save_branding → brandColors): the hex is
-- re-tested against ^#[0-9a-f]{6}$, the name is trimmed to 40 chars, the list to 12. So a
-- hand-written row or a stray key cannot reach the designer or an email send.
--
-- Default '[]' and NOT NULL: every read downstream can map over it without a null check, and a
-- tenant who never opens Branding has an empty palette rather than an absent one.

begin;

alter table client_configs
  add column if not exists brand_colors jsonb not null default '[]'::jsonb;

-- Belt and braces for the one invariant the edge function also enforces: an array, never an
-- object or a scalar. A tenant row that somehow holds {"a":1} would make every consumer's
-- .map() throw in the browser.
alter table client_configs
  drop constraint if exists client_configs_brand_colors_array;
alter table client_configs
  add constraint client_configs_brand_colors_array
  check (jsonb_typeof(brand_colors) = 'array');

comment on column client_configs.brand_colors is
  'Builder brand palette: jsonb array of {name, hex} (max 12), drawn as swatches in the form designer and email editor. Additive to accent_color/header_bg. Migration 336.';

commit;
