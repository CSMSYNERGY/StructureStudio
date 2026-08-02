-- 076_commission_settings.sql
-- Commission tracking feature — slice 1: per-tenant commission RULES (owner-configured).
-- The confidential per-user RATES and the payouts report are separate later slices
-- (service-role only). Applied live via MCP on 2026-08-02 and recorded in the ledger;
-- this file is the in-repo record (do NOT `db push`).

create table if not exists public.commission_settings (
  client_id          text primary key,
  enabled            boolean not null default false,
  base_type          text not null default 'pretax_subtotal'
                       check (base_type in ('pretax_subtotal','gross_profit')),
  earned_on          text not null default 'collected'
                       check (earned_on in ('sold','delivered','collected')),
  payout_frequency   text not null default 'biweekly'
                       check (payout_frequency in ('weekly','biweekly','monthly','custom')),
  custom_days        integer check (custom_days is null or custom_days > 0),
  period_anchor      date not null default current_date,
  clawback_on_cancel boolean not null default true,
  updated_at         timestamptz not null default now(),
  updated_by         uuid
);

-- Owner check as SECURITY DEFINER: client_users is not directly selectable under RLS
-- (tenant resolution goes through current_client_id(), also DEFINER), so an inline
-- subquery in a policy would see nothing. Mirrors that pattern for the role.
create or replace function public.current_user_is_owner()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.client_users cu
    where cu.user_id = auth.uid()
      and cu.client_id = public.current_client_id()
      and cu.role = 'owner'
  );
$$;

-- Authenticated-only (matches current_client_id()'s posture; anon never needs it).
revoke execute on function public.current_user_is_owner() from anon, public;
grant execute on function public.current_user_is_owner() to authenticated;

alter table public.commission_settings enable row level security;

create policy commission_settings_owner_select on public.commission_settings
  for select to authenticated
  using (client_id = public.current_client_id() and public.current_user_is_owner());

create policy commission_settings_owner_insert on public.commission_settings
  for insert to authenticated
  with check (client_id = public.current_client_id() and public.current_user_is_owner());

create policy commission_settings_owner_update on public.commission_settings
  for update to authenticated
  using (client_id = public.current_client_id() and public.current_user_is_owner())
  with check (client_id = public.current_client_id() and public.current_user_is_owner());
