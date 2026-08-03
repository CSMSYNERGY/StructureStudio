-- 069_fixture_show_image_on_estimate: per-door toggle for whether the door's photo is
-- attached to its line on the GHL estimate (mirrors building_styles.show_image_on_estimate).
-- submit-estimate reads it live per door (by fixtureItemId) at submit time. Additive,
-- default true. HAND-APPLY via MCP; record in the ledger.

alter table public.fixture_items
  add column if not exists show_image_on_estimate boolean not null default true;
