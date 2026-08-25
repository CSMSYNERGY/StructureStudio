-- 129_ai_style_calls_source.sql — tell a paid video generation apart from a free photo draft.
--
-- WHY. `ai_style_calls` (086) records every calibrate_style_ai call and enforces the
-- 10/tenant/day cap. It carries no `source`, so a photo draft and a walk-around video
-- generation are INDISTINGUISHABLE in the data. Three consequences, all of which bite the
-- moment money is attached:
--
--   1. "How many paid generations happened?" is unanswerable from the ledger.
--   2. The $20 charge cannot be scoped to video without it. Ahsan's decision, 2026-08-25:
--      charge fires "when a 3D model is created using the uploaded video". That is also
--      the right call on the merits — the $20 is priced off the VIDEO's Anthropic cost,
--      and the photo path (the four Front/Back/Left/Right slots) is slated for removal.
--      Charging $20 for a flow we are about to delete is a support liability with no
--      upside.
--   3. "Why was I charged?" is a timestamp correlation rather than a join.
--
-- Default is 'photos', which is what every existing row was: the video path post-dates the
-- rest of this table's history.
--
-- Blast radius is zero: `ai_style_calls` has exactly ONE reader and ONE writer in the
-- whole repo (portal-settings' calibrate_style_ai).
--
-- Rollback:
--   alter table public.ai_style_calls
--     drop column if exists source,
--     drop column if exists charged_cents,
--     drop column if exists wallet_tx_id;

alter table public.ai_style_calls
  add column if not exists source text not null default 'photos'
    check (source in ('photos', 'video')),
  -- What the tenant was charged, denormalised onto the call so the daily-cap ledger and
  -- the money ledger can be read side by side without a join in the common case.
  add column if not exists charged_cents integer,
  -- Soft link, deliberately not a foreign key: a CRM/billing bookkeeping failure must
  -- never be able to block the row that IS the spend cap. Same reasoning as the guarded
  -- block around crm_ensure_contact in save_design.
  add column if not exists wallet_tx_id bigint;

create index if not exists ai_style_calls_client_source
  on public.ai_style_calls (client_id, source, called_at desc);

comment on column public.ai_style_calls.source is
  'photos = the free four-slot draft, still governed only by the 10/day cap. video = the '
  'walk-around generation, which is what usage_prices.video_3d_generation charges for.';
