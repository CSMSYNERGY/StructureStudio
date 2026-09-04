-- 185_setup_gating.sql — the setup checklist stops handing builders work they cannot do.
--
-- Carolyn 2026-09-04: "segment the Getting Setup ... don't give them a task that is not in
-- their subscription, and secondly, anything that isn't fully developed on our side yet,
-- where they can't do the setup should stay in the list, but hidden from the new builder
-- until we finalize that build out."
--
-- Two axes, two columns, and they are NOT the same question:
--
--   requires_feature  the step is only doable with a paid add-on. The builder still SEES
--                     it, greyed with a padlock and a link to Billing (her call — it
--                     doubles as the upsell), and it is left out of their "X of Y done".
--   builder_visible   we have not finished building this part of the product, so no
--                     builder should see the step at all. It stays in the template and in
--                     every tenant's list, waiting.
--
-- ── WHY BOTH LIVE ON THE TEMPLATE AND NOT ON tenant_setup_items ───────────────────────
-- These are facts about the STEP, not about one builder's copy. Putting them here means
-- flipping builder_visible when a build lands reaches EVERY existing builder at once,
-- with no per-tenant backfill — which is the entire point of requirement 2. portal-setup
-- reads them through tenant_setup_items.template_item_id at request time.
--
-- It also means neither copy site (admin-catalog's create_client, portal-projects'
-- setup_assign_template) and neither tenant select list changes, so CLAUDE.md's "a new
-- column must be added in four places" rule does not apply here. Verified 2026-09-04 that
-- all 57 tenant rows across the three tenants carry a non-null template_item_id, so the
-- lookup resolves for every existing row.
--
-- ⚠️ builder_visible IS NOT `active`, and the editor labels them apart for this reason.
-- `active` means "hand this step to NEW builders" — both copy sites filter on
-- `.eq("active", true)` — so turning it off leaves every existing builder's copy sitting
-- in their list. That is the wrong tool for "we have not built this yet", which has to
-- reach the builders who already hold a copy.
--
-- ⚠️ DELETING a template row nulls tenant_setup_items.template_item_id (on delete set
-- null), which would silently un-hide and un-lock the step in lists nobody is looking at.
-- portal-projects' setup_template_delete now refuses that when the row is hidden or gated
-- and any tenant still points at it, and tells the operator to hide it instead.
--
-- NO SEED HERE, DELIBERATELY. The template is DATA (CLAUDE.md): the initial flags — hide
-- "Send email from your own domain" and "3D: calibrate how your styles look", and gate
-- steps 16-18 on schedule_builds / quickbooks_sync / on_demand_pricing — are set through
-- the Projects → Client Setup editor once it can set them. Migration 160's seed is the
-- historical record of the v2 content, not the live truth.
--
-- No CHECK constraint on requires_feature on purpose: that would be a fourth place the
-- feature keys are written down. setup_template_save validates against FEATURE_KEYS in
-- _shared/featureCheck.ts, which is the list portal-billing's own map is kept in step with.
--
-- No index: the template is 19 rows and is read by primary key.
--
-- Rollback:
--   alter table public.setup_template_items
--     drop column if exists requires_feature, drop column if exists builder_visible;

alter table public.setup_template_items
  add column if not exists requires_feature text,
  add column if not exists builder_visible  boolean not null default true;

comment on column public.setup_template_items.requires_feature is
  'billing_plans.feature this step needs (null = always doable). The builder still sees a '
  'gated step, padlocked and excluded from their progress count — portal-setup decides, '
  'from the VIEWED tenant''s subscription or operator grant.';

comment on column public.setup_template_items.builder_visible is
  'false = we have not finished building this part yet, so no builder sees the step. It '
  'stays in the template and in every tenant list; flipping this true reveals it for '
  'everyone at once. NOT the same as `active`, which only governs what NEW builders are '
  'given.';
