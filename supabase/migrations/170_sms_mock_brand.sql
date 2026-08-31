-- 170 — Mock brand registrations.
--
-- Twilio's A2P API takes Mock=true on BrandRegistrations: no TCR fee, no billing event, no
-- vetting. It exists so an ISV can exercise the whole chain before committing a real business
-- and real money to the carriers. We had no way to ask for one, so the only way to test the
-- registration path was to run it for real.
--
-- ⚠️ A MOCK BRAND ON A REAL BUILDER IS THE FAILURE MODE THIS FILE EXISTS TO PREVENT.
-- A mock brand reports PENDING and then approves like any other, but its campaign CANNOT
-- send SMS and the whole thing is deleted after 30 days. A builder holding one would see a
-- setup that looks finished, and texts that silently never arrive — the worst shape of bug
-- this feature could have.
--
-- So the flag is not an environment variable somebody forgets to unset. It is a per-row
-- boolean, default FALSE, and the trigger below makes it IMPOSSIBLE to set on any tenant that
-- is not our own internal account. Enforced in the database rather than only in the edge
-- function because a direct table write must not be able to do it either.
--
-- Rollback:
--   drop trigger if exists sms_registrations_mock_internal_only on public.sms_registrations;
--   drop function if exists public.sms_registrations_mock_is_internal_only();
--   alter table public.sms_registrations drop column if exists mock_brand;

alter table public.sms_registrations
  add column if not exists mock_brand boolean not null default false;

comment on column public.sms_registrations.mock_brand is
  'Register this brand with Twilio Mock=true: free, unvetted, cannot send, deleted after 30 days. Internal accounts only, enforced by trigger.';

create or replace function public.sms_registrations_mock_is_internal_only()
returns trigger
language plpgsql
security definer
set search_path = public
as $fn$
begin
  if new.mock_brand is true then
    if not exists (
      select 1 from public.client_settings cs
      where cs.client_id = new.client_id and cs.internal_account is true
    ) then
      raise exception
        'mock_brand is only allowed on an internal account (client_id=%). A mock brand cannot send SMS, so a real builder must never hold one.',
        new.client_id
        using errcode = 'check_violation';
    end if;
  end if;
  return new;
end;
$fn$;

drop trigger if exists sms_registrations_mock_internal_only on public.sms_registrations;
create trigger sms_registrations_mock_internal_only
  before insert or update of mock_brand, client_id on public.sms_registrations
  for each row execute function public.sms_registrations_mock_is_internal_only();
