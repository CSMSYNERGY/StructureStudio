-- 209_change_order_policy.sql — the tenant's rules for changing a SIGNED order.
--
-- WHY. Carolyn, 2026-09-07: "there needs to be an unlock feature for an admin/crew leader to
-- Unlock it before a sales rep can make a change ... additionally ... a feature in the settings
-- that allow admin/builder to set how many days after an order is written that a sales rep can
-- do a change order without their approval. (Lets say they just submitted an order and the
-- customer decides to change a small detail shortly thereafter ... they should be allowed to
-- make the change as it doesn't affect the crew yet) ... and the admin should be able to set a
-- $ amount as a change order fee (if they want) and it automatically gets applied (after said
-- amount of days)."
--
-- This migration adds ONLY the settings. Nothing reads them until 211 (the gate) and the
-- portal-settings actions that follow. Applying this file changes no behaviour whatsoever.
--
-- ⚠️ `co_unlock_required` DEFAULTS TO FALSE, AND THAT IS LOAD-BEARING. With it off the whole
-- unlock/fee regime is dormant and every tenant behaves exactly as it does today on the day
-- this lands. A migration that can take an ability away from a signed-in builder — here, a
-- rep's ability to revise an order they just wrote — must not do it by default. The builder
-- switches it on when they have decided their own window and fee. 188 and 199 both take this
-- posture; it is the reason neither of them broke anyone.
--
-- NOT NULL WITH A DEFAULT, NOT A NULLABLE TRI-STATE. An earlier draft had `co_free_days` NULL
-- meaning "no window at all" and 0 meaning "no free days", following ss_tax_rate's
-- refuse-rather-than-invent discipline. That distinction earns its keep for a TAX RATE, where
-- "not configured" and "0%" are genuinely different answers and one of them is a legal claim.
-- It earns nothing here: `co_unlock_required` already says whether the regime is on at all, so
-- a second way to say "off" is a state to get wrong in three places for no gain.
--
-- WHY `co_fee_taxable` AND NOT A HARD RULE. Carolyn, asked whether the fee is taxed: "one it's
-- own line and in settings admin determines if taxed or not". Sales tax on a service charge is
-- state-by-state and it prints on a document the customer signs — that is the builder's
-- accountant's call, not ours. The flag threads exactly like `ss_tax_delivery` (127/158), and
-- needs no new tax plumbing: estimate_lines already carries a per-line `taxable`/`nonTaxable`
-- flag and subtotalsFromSnapshot already keeps the two pools apart.
--
-- Rollback (safe at any point before 211 reads them):
--   alter table public.client_settings
--     drop column if exists co_unlock_required, drop column if exists co_free_days,
--     drop column if exists co_fee_cents,       drop column if exists co_fee_taxable,
--     drop column if exists co_fee_label,       drop column if exists co_unlock_hours;

-- ── PART 0 — blast radius ──────────────────────────────────────────────────────────────
-- client_settings is service-role only (RLS on, zero policies), so nothing in a browser can
-- read these before the UI ships. Confirmed at apply time by the assertion in PART 2.
--
--   select client_id, invoice_in_ghl from public.client_settings order by client_id;
--   -- 2026-09-07: 7 rows; invoice_in_ghl = false on structure-studio and abc-builder only,
--   -- i.e. the only two tenants any of this can reach, and both are ours.

-- ── PART 1 — the columns ───────────────────────────────────────────────────────────────
alter table public.client_settings
  -- OFF = today's behaviour exactly: any rep holding change_orders may revise a signed order,
  -- with no unlock and no fee, which is what they can do now.
  add column if not exists co_unlock_required boolean not null default false,
  -- Days from orders.ordered_at during which no unlock is needed. 0 = every change needs one.
  add column if not exists co_free_days integer not null default 0,
  -- Applied automatically to a change raised AFTER the window. 0 = no fee.
  add column if not exists co_fee_cents integer not null default 0,
  add column if not exists co_fee_taxable boolean not null default true,
  -- Prints on the customer's document, so it is bounded like ss_tax_label.
  add column if not exists co_fee_label text not null default 'Change order fee',
  -- How long a granted unlock stays usable. An unlock is permission for ONE change, not a
  -- standing bypass, and an order left open forever is the failure mode this closes.
  add column if not exists co_unlock_hours integer not null default 72;

-- Bounds, so a fat finger in Settings cannot put a four-figure fee or a ten-year window on a
-- customer's order. Checked here as well as in portal-settings for 158's reason: the UI is one
-- writer of this table and the edge functions are another.
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'client_settings_co_free_days_bounds') then
    alter table public.client_settings add constraint client_settings_co_free_days_bounds
      check (co_free_days >= 0 and co_free_days <= 365);
  end if;
  if not exists (select 1 from pg_constraint where conname = 'client_settings_co_fee_bounds') then
    alter table public.client_settings add constraint client_settings_co_fee_bounds
      check (co_fee_cents >= 0 and co_fee_cents <= 1000000);
  end if;
  if not exists (select 1 from pg_constraint where conname = 'client_settings_co_unlock_hours_bounds') then
    alter table public.client_settings add constraint client_settings_co_unlock_hours_bounds
      check (co_unlock_hours >= 1 and co_unlock_hours <= 720);
  end if;
  if not exists (select 1 from pg_constraint where conname = 'client_settings_co_fee_label_len') then
    alter table public.client_settings add constraint client_settings_co_fee_label_len
      check (length(co_fee_label) between 1 and 40);
  end if;
end $$;

comment on column public.client_settings.co_unlock_required is
  'Migration 209. OFF (default) = the change-order unlock regime is dormant and a rep with change_orders=edit may revise a signed order exactly as before. ON = a change raised after co_free_days needs an unlock from someone holding change_order_approve.';
comment on column public.client_settings.co_fee_cents is
  'Migration 209. Auto-applied to a change raised after the free window, as its own line on the customer document. Stamped onto the change_orders row at insert and frozen there, so editing this setting never moves a fee a customer already signed for.';

-- ── PART 2 — apply-time assertions. These RAISE, aborting the transaction. ──────────────
do $$
declare n int;
begin
  select count(*) into n from information_schema.columns
   where table_schema = 'public' and table_name = 'client_settings'
     and column_name in ('co_unlock_required','co_free_days','co_fee_cents',
                         'co_fee_taxable','co_fee_label','co_unlock_hours');
  if n <> 6 then raise exception '209: expected 6 new columns, found %', n; end if;

  -- THE ONE THAT MATTERS: every existing tenant must come out of this dormant.
  if exists (select 1 from public.client_settings where co_unlock_required is not false) then
    raise exception '209: a tenant would be left with the unlock regime ON — that is a behaviour change on apply';
  end if;
  if exists (select 1 from public.client_settings where co_fee_cents <> 0) then
    raise exception '209: a tenant would be left with a change-order fee already set';
  end if;

  -- client_settings must still be unreadable from a browser. A settings column that became
  -- browser-readable would leak a tenant's fee schedule to their own staff before the screen
  -- that explains it exists — harmless today, and exactly the kind of thing that stops being
  -- harmless silently.
  if exists (
    select 1 from pg_policies
     where schemaname = 'public' and tablename = 'client_settings'
       and 'authenticated' = any(roles)
  ) then
    raise exception '209: client_settings has an authenticated policy — it is service-role only';
  end if;
end $$;
