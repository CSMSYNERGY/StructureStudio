-- 235_delivery_distance_cache: driving miles we have already paid Google for. Applied live 2026-09-14.
--
-- WHY. The designer asks for a delivery quote as the customer types their address, and
-- submit-estimate asks again when they submit. Both go through _shared/deliveryDistance.ts,
-- which reads this table first and calls the Routes API only for a miss — so one address costs
-- one lookup, and, more importantly, the preview and the estimate read the SAME whole-mile figure
-- (stored already rounded UP) and therefore agree to the penny. Rows older than 90 days are
-- treated as missing by the reader; nothing deletes them on a schedule.
--
-- Keyed per tenant so one builder's lookups never serve another's, and so a tenant's rows can be
-- cleared on their own. Keys are normalised address strings (deliveryFee.ts addressKey), not
-- ids: an origin is whichever address the builder typed, and a customer's address has no id.

begin;

create table if not exists public.delivery_distance_cache (
  client_id    text not null,
  origin_key   text not null,
  dest_key     text not null,
  miles        numeric not null check (miles >= 0),
  provider     text not null default 'google_routes',
  resolved_at  timestamptz not null default now(),
  primary key (client_id, origin_key, dest_key)
);

-- Service-role only (the 204 rate_buckets posture): no browser role reads or writes it.
alter table public.delivery_distance_cache enable row level security;
revoke all on public.delivery_distance_cache from public;
revoke all on public.delivery_distance_cache from anon, authenticated;
create index if not exists delivery_distance_cache_resolved_idx
  on public.delivery_distance_cache (resolved_at);

comment on table public.delivery_distance_cache is
  'Whole driving miles per (tenant, origin address, customer address), rounded up before storage so every reader agrees. Written best-effort by _shared/deliveryDistance.ts; stale after 90 days.';

commit;
