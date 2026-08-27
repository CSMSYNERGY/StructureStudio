-- 141_crm_field_changes.sql — the changelog gets something to log, and contacts get an editor.
--
-- Carolyn, 2026-08-26 25:18, on what "changelog" meant in the CRM she came from: "if they
-- changed ownership of a lead from one person to another person, that was logged. Everything
-- that they did with that lead was logged." Her changelog read 0.
--
-- Migration 140-era code widened the chip to every lifecycle event the feed emits, which
-- fixed the empty chip. It could not fix the deeper half: there were no FIELD edits to log,
-- because there was no way to edit a contact. 130 shipped name/phone/email/address and the
-- owner and label columns as READ-ONLY, saying in its own header that they would stay that
-- way "until there is an editor". This is that editor, and its audit trail.
--
-- ⚠️ THIS IS THE FIRST WRITE TO crm_contacts FROM ANYWHERE BUT crm_ensure_contact.
-- That function (132) is fed by anonymous design submissions, so it is deliberately
-- ENRICH-NEVER-BLANK: every field is `coalesce(nullif(new,''), old)`, and it therefore
-- CANNOT clear a wrong email or fix a typo'd name. A human editor has to be able to blank a
-- field. That is why this is a separate function rather than another caller of that one.

create table if not exists public.crm_field_changes (
  id          uuid primary key default gen_random_uuid(),
  client_id   text not null,
  contact_id  uuid not null references public.crm_contacts(id) on delete cascade,
  field       text not null,
  old_value   text,
  new_value   text,
  changed_by  uuid,
  created_at  timestamptz not null default now()
);

-- The feed reads this per contact, newest first — the same access path every other
-- crmFeed source uses.
create index if not exists crm_field_changes_contact
  on public.crm_field_changes (client_id, contact_id, created_at desc);

-- New tables ship world-readable; 112's lesson. Revoke, then grant back only the read the
-- portal needs. Every write is service-role, through portal-settings.
alter table public.crm_field_changes enable row level security;
revoke all on public.crm_field_changes from anon, authenticated;
grant select on public.crm_field_changes to authenticated;
drop policy if exists crm_field_changes_owner_select on public.crm_field_changes;
create policy crm_field_changes_owner_select on public.crm_field_changes
  for select to authenticated using (client_id = public.current_client_id());

-- ── The editor ─────────────────────────────────────────────────────────────────────────
--
-- One function, because three things have to happen together or not at all: the row is
-- updated, phone_digits is REDERIVED, and one changelog row is written per field that
-- actually changed. Splitting them across the edge function would let a save succeed with
-- no audit trail, or an audit trail for a save that failed.
--
-- ⚠️ phone_digits HAS NO TRIGGER AND IS NOT GENERATED. Only `email_lower` is generated
-- (130). Nothing derives phone_digits for you: 132 extracted crm_phone_key precisely so the
-- resolver, the backfill and any future writer could not disagree about what a phone key
-- is, and this function is that future writer. Update `phone` without it and the contact
-- silently stops matching their own next design — which is the split-contact bug 132 exists
-- to close, reopened from a new direction.
--
-- NULL means "leave alone"; the empty string means "clear it". That distinction is the
-- whole reason this is not crm_ensure_contact.
create or replace function public.crm_update_contact(
  p_client_id text,
  p_id        uuid,
  p_name      text default null,
  p_phone     text default null,
  p_email     text default null,
  p_actor     uuid default null
)
returns integer
language plpgsql
security definer
set search_path to ''
as $fn$
declare
  v_old   public.crm_contacts%rowtype;
  v_name  text;
  v_phone text;
  v_email text;
  v_digits text;
  v_n     integer := 0;
begin
  select * into v_old from public.crm_contacts
   where id = p_id and client_id = p_client_id;
  if not found then
    raise exception 'contact not found' using errcode = 'no_data_found';
  end if;

  -- btrim so a field of spaces reads as "cleared" rather than as a value made of spaces.
  v_name  := case when p_name  is null then v_old.name  else nullif(btrim(p_name), '')  end;
  v_phone := case when p_phone is null then v_old.phone else nullif(btrim(p_phone), '') end;
  v_email := case when p_email is null then v_old.email else nullif(btrim(p_email), '') end;
  v_digits := public.crm_phone_key(v_phone);

  -- One row per field that genuinely moved. `is distinct from` rather than `<>` so a change
  -- to or from NULL counts — clearing an email is exactly the kind of edit somebody will
  -- later want to explain.
  if v_name is distinct from v_old.name then
    insert into public.crm_field_changes (client_id, contact_id, field, old_value, new_value, changed_by)
    values (p_client_id, p_id, 'name', v_old.name, v_name, p_actor);
    v_n := v_n + 1;
  end if;
  if v_phone is distinct from v_old.phone then
    insert into public.crm_field_changes (client_id, contact_id, field, old_value, new_value, changed_by)
    values (p_client_id, p_id, 'phone', v_old.phone, v_phone, p_actor);
    v_n := v_n + 1;
  end if;
  if v_email is distinct from v_old.email then
    insert into public.crm_field_changes (client_id, contact_id, field, old_value, new_value, changed_by)
    values (p_client_id, p_id, 'email', v_old.email, v_email, p_actor);
    v_n := v_n + 1;
  end if;

  if v_n = 0 then
    return 0;                                  -- nothing moved; do not bump updated_at
  end if;

  update public.crm_contacts
     set name = v_name,
         phone = v_phone,
         phone_digits = v_digits,
         email = v_email,
         updated_at = now()
   where id = p_id and client_id = p_client_id;

  return v_n;
end
$fn$;

-- Definer-only, exactly like crm_ensure_contact (132). The browser must never reach this:
-- `contacts` is a real access area whose driver and crew-leader presets resolve to `none`,
-- and RLS can only express tenant scoping, not that. portal-settings enforces the area.
revoke execute on function public.crm_update_contact(text, uuid, text, text, text, uuid) from public, anon, authenticated;
