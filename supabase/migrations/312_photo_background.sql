-- 312_photo_background.sql — Online Shop phase 2: change a lot photo's background with AI.
--
-- ⛔ APPLY BY HAND. Pipe to `supabase db query --linked` (stdin), then record it:
--      insert into supabase_migrations.schema_migrations (version, name) values ('312', '312_photo_background') returning version, name;
--    REHEARSAL: sed 's/^commit;\r\{0,1\}$/rollback;/' supabase/migrations/312_photo_background.sql | npx supabase db query --linked -o csv
--
-- ── WHY (Carolyn 2026-10-17) ─────────────────────────────────────────────────────────────
-- "Bring in the feature from FramedUp of changing the background of the images." Builders shoot
-- lot buildings against parking lots and fences; one press puts the same building in a backyard.
-- FramedUp's proven recipe is reused unchanged: one fal.ai call to GPT Image 2 edit with a "keep
-- the building EXACTLY, replace only the background" prompt. The result is ADDED next to the
-- original (inventory_unit_photos.source_photo_id, ai_edited) — the original is never replaced.
--
-- Metered to the builder's WALLET (Carolyn's call): hold before the call, capture on success,
-- release on failure — the 3D-generation pattern (migrations 128/248).
--
-- ── THE METER SHIPS SWITCHED OFF, AND THAT IS LOAD-BEARING ───────────────────────────────
-- usage_prices.active=false normally means "run free" (the arming rail). This feature REFUSES
-- instead while the meter is off, so nothing runs at CSM's expense before Carolyn has set a price:
--   update public.usage_prices set price_cents = <cents>, active = true, updated_at = now()
--    where kind = 'photo_background_change';

begin;

insert into public.usage_prices (kind, label, unit_label, price_cents, active, visible, sort_order, note)
values ('photo_background_change', 'Photo background change', 'photo', 0, false, true, 40,
        'Online Shop: AI background change on a lot photo (fal.ai GPT Image 2 edit). Set the price, then set active = true.')
on conflict (kind) do nothing;

create table public.inventory_photo_ai_edits (
  id uuid primary key default gen_random_uuid(),
  client_id text not null,
  unit_id uuid not null references public.inventory_units(id) on delete cascade,
  source_photo_id uuid references public.inventory_unit_photos(id) on delete set null,
  scene text not null check (char_length(scene) between 1 and 400),
  model text not null,
  fal_request_id text,
  status_url text,
  response_url text,
  status text not null default 'queued' check (status in ('queued','done','failed')),
  hold_id bigint,
  result_photo_id uuid references public.inventory_unit_photos(id) on delete set null,
  error text,
  requested_by uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index inventory_photo_ai_edits_client on public.inventory_photo_ai_edits (client_id, created_at desc);
alter table public.inventory_photo_ai_edits enable row level security;
-- No policy: service role only (portal-settings), like wallet_transactions.

select '312' as migration,
  to_regclass('public.inventory_photo_ai_edits') is not null as jobs_table,
  (select active from public.usage_prices where kind = 'photo_background_change') as meter_active;

commit;
