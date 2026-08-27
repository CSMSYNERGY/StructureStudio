-- 132_crm_phone_normalize.sql — strip the US country code before matching a contact.
--
-- FOUND BY THE 130 BACKFILL, not by reading. 132 designs resolved to 60 contacts, and four
-- names appeared twice. Inspecting two of them showed the same human split across two rows:
--
--   Nevin Friesen   1707362566   nevin@jrbarns.com        22 designs
--   Nevin Friesen   7073625667   (no email)                0 designs
--
-- `regexp_replace(phone, '\D', '', 'g')` is not a phone normalizer, it is a digit filter.
-- "+1 707-362-5667" and "707-362-5667" are the same number and produce DIFFERENT keys, so
-- the second submission created a second contact instead of enriching the first.
--
-- That is precisely the failure 130 exists to prevent, arriving one layer lower down: a
-- note written on one row would be invisible from the other, and which row a customer lands
-- on depends on whether they typed a country code that day.
--
-- THE FIX: an 11-digit string beginning with 1 is a US/Canada number written with its
-- country code; take the last 10. Anything else is left alone — this is deliberately NOT a
-- general libphonenumber, because guessing at international formats would create the
-- opposite bug (two genuinely different numbers collapsing into one contact).
--
-- Rollback: re-create crm_ensure_contact from 130 and drop crm_phone_key.
--   (The merged rows are NOT automatically un-merged; merged_into records where they went.)

-- One definition, used by the resolver, the backfill and the repair below, so the three
-- can never disagree about what "the same number" means.
create or replace function public.crm_phone_key(p_phone text)
returns text
language sql immutable
set search_path to ''
as $fn$
  select nullif(
    case
      when length(d) = 11 and left(d, 1) = '1' then right(d, 10)
      else d
    end, '')
  from (select regexp_replace(coalesce(p_phone, ''), '\D', '', 'g') as d) s;
$fn$;

create or replace function public.crm_ensure_contact(
  p_client_id text, p_name text, p_phone text, p_email text
) returns uuid
language plpgsql security definer set search_path to ''
as $fn$
declare
  v_digits text := public.crm_phone_key(p_phone);
  v_email  text := nullif(lower(btrim(coalesce(p_email, ''))), '');
  v_id uuid;
begin
  if v_digits is null and v_email is null then return null; end if;

  perform pg_advisory_xact_lock(
    hashtext('ss_crm_contact:' || p_client_id || ':' || coalesce(v_digits, v_email)));

  if v_digits is not null then
    select id into v_id from public.crm_contacts
     where client_id = p_client_id and phone_digits = v_digits and merged_into is null;
  end if;
  if v_id is null and v_email is not null then
    select id into v_id from public.crm_contacts
     where client_id = p_client_id and email_lower = v_email and merged_into is null;
  end if;

  if v_id is null then
    insert into public.crm_contacts (client_id, name, phone, phone_digits, email)
      values (p_client_id, nullif(btrim(coalesce(p_name, '')), ''), p_phone, v_digits, p_email)
      returning id into v_id;
  else
    update public.crm_contacts set
      name         = coalesce(nullif(btrim(coalesce(p_name, '')), ''), name),
      phone        = coalesce(nullif(btrim(coalesce(p_phone, '')), ''), phone),
      phone_digits = coalesce(v_digits, phone_digits),
      email        = coalesce(nullif(btrim(coalesce(p_email, '')), ''), email),
      updated_at   = now()
    where id = v_id;
  end if;
  return v_id;
end $fn$;

revoke execute on function public.crm_ensure_contact(text, text, text, text)
  from public, anon, authenticated;

-- ─────────────────────────────────────────────────────────────────────────────
-- ⚠️ A SECOND, DIFFERENT DEFECT — FOUND HERE, DELIBERATELY NOT AUTO-REPAIRED.
-- ─────────────────────────────────────────────────────────────────────────────
-- The country-code fix above does NOT resolve the two duplicate pairs the 130 backfill
-- surfaced, because those are not a country-code problem. The raw values are:
--
--   Nevin Friesen   "(170) 736-2566"   <- and, separately, "(707) 362-5667"
--   Izaak Neil      "(157) 350-8782"   <- and, separately, "(573) 508-7821"
--
-- Read the first of each pair as digits: 1707362566. That is "+1 707 362 5667" run through
-- a TEN-digit US mask — the leading 1 was treated as the start of the area code and THE
-- LAST DIGIT WAS DROPPED. The number is not merely formatted oddly, it is destroyed: the
-- final digit no longer exists anywhere in the row.
--
-- Both mangled values are already present in `designs.contact`, so this happened at CAPTURE
-- time in whatever formats the phone field, not in migration 130. That is the bug worth
-- fixing; everything here is downstream of it.
--
-- WHY THIS MIGRATION DOES NOT MERGE THEM. Recovering the pair requires matching on the
-- first nine digits and then ASSUMING the two records are the same person. That assumption
-- is sound here (no valid NANP area code begins with 1, so a 10-digit key starting with 1
-- is provably not a real number) but it is still a judgement about two named customers'
-- records, made from a heuristic, executed irreversibly against live data. Two rows out of
-- sixty is not worth a script that could silently fuse two different people if the
-- heuristic is ever wrong on a bigger dataset. `merged_into` exists for when someone
-- decides; a human should press the button.
--
-- FIND THEM AT ANY TIME:
--
--   select id, client_id, name, phone, phone_digits, email
--     from public.crm_contacts
--    where merged_into is null
--      and length(phone_digits) = 10
--      and left(phone_digits, 1) = '1';       -- impossible for a real NANP number
--
-- and their likely partner:
--
--   select * from public.crm_contacts
--    where merged_into is null
--      and left(phone_digits, 9) = substr('<the mangled key>', 2);

-- Re-key every surviving row to the normalized form, so the resolver's lookups hit.
update public.crm_contacts
   set phone_digits = public.crm_phone_key(phone), updated_at = now()
 where merged_into is null
   and phone is not null and phone <> ''
   and phone_digits is distinct from public.crm_phone_key(phone);
