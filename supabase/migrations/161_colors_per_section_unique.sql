-- ✅ APPLIED LIVE 2026-08-29 and LEDGERED (version 20260829115211).
-- Renumbered 156 -> 161: 156 was already taken by 156_load_design_legacy_code_redaction on
-- origin/beta, and 157-160 landed while this file sat untracked. Verified free against the
-- LEDGER, not the folder. Verified applied before ledgering: colors carries zero unique
-- CONSTRAINTS and all three partial indexes (colors_paint_label_uniq / _shingle_ / _metal_)
-- already exist, so this file records what live already does rather than changing it.
--
-- 161_colors_per_section_unique: a colour name is unique WITHIN A SECTION, not across the
-- whole product.
--
-- Carolyn, 2026-08-28 @55:00, adding a metal Black for Yoder Barns while a paint Black
-- already existed: "black is a duplicate key, it violates the unique constraint of colors,
-- client and ID label key." She then proposed working around it by renaming them BLM / BLS.
-- The workaround is the bug talking.
--
-- 009 created `unique (client_id, label)` when a colour row had exactly two flags (siding,
-- trim) and one picker. 038 added shingle/metal and 116 added door — categories are BOOLEAN
-- FLAGS ON THE SAME ROW, so one tenant still gets one "Black" across every picker in the
-- product. A shingle Black and a metal Black are different physical products from different
-- suppliers; there is no reading of the domain where sharing a name is a mistake.
--
-- ⚠️ 116's own header documents this exact trap and dodged it by giving windows a SEPARATE
-- TABLE ("colors has unique(client_id,label) and nearly every tenant wants window White
-- alongside paint White"). That was the right call for windows, whose rate is a flat
-- per-window dollar rather than the pricing_method engine — but it is not a pattern to
-- repeat, and its own comment says a fourth pseudo-category would disturb every filter.
-- This fixes the constraint instead.
--
-- THE SECTIONS ARE THE UI'S, NOT AN INVENTION. `ColorsView.renderSection`
-- (portal/03-catalog.jsx) splits the one flat list into exactly three tables:
--     paint   = (not shingle and not metal)   -- siding/trim/door tick within it
--     shingle = shingle
--     metal   = metal
-- The three indexes below are that filter, character for character. A name must be unique
-- inside one dropdown; across two dropdowns it is two different products. Keeping the
-- predicates identical to the render filter is the whole safety argument: any future edit
-- must move both, or the screen and the database disagree about what "duplicate" means.
--
-- A row flagged BOTH shingle and metal sits in two sections and is covered by two indexes.
-- Nothing forbids that today and nothing here starts to.

begin;

-- Creation cannot fail on existing data: the constraint being dropped was STRICTER than any
-- of the three replacements, so every row already satisfies all of them.
alter table public.colors drop constraint if exists colors_client_id_label_key;

create unique index if not exists colors_paint_label_uniq
  on public.colors (client_id, label) where (not shingle and not metal);
create unique index if not exists colors_shingle_label_uniq
  on public.colors (client_id, label) where shingle;
create unique index if not exists colors_metal_label_uniq
  on public.colors (client_id, label) where metal;

commit;

-- NB on the one caller that named the old constraint: 009's seed ends with
-- `on conflict (client_id, label) do nothing`. It is a historical, already-applied
-- migration and never runs again. The live write path is portal-settings' `save_colors`,
-- which UPDATEs by id and INSERTs plainly — it names no conflict target, so it is
-- unaffected. Verified by grep before dropping.
