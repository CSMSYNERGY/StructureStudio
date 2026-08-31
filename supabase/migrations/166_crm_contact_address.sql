-- APPLIED LIVE 2026-08-29 and LEDGERED (version 20260829223026).
--
-- 166_crm_contact_address: the contact editor can finally edit the address.
--
-- Carolyn, 2026-08-28 @21:01, looking at the record page: "We still need like address. You
-- have it in here, but EVERYTHING THAT IS CONTACT RELATED should be in here. Did you just
-- specify just these?" -- and the answer was yes, just name/phone/email.
--
-- ⚠️ NO NEW COLUMNS. crm_contacts has carried street, city, state and zip since 130; they
-- are populated from submitted designs and shown read-only, and only the EDITOR was missing
-- them. Checked against live before writing this, because "add the address columns" was the
-- obvious wrong first move.
--
-- So this is entirely about crm_update_contact, which is the one write path and also the
-- thing that writes the changelog. Four more fields, same three rules as the existing three:
--   * NULL      => this field is not being edited, keep what is there
--   * ''        => a deliberate clear (btrim'd, so a field of spaces reads as cleared)
--   * changed   => one crm_field_changes row per field that genuinely moved, `is distinct
--                  from` so a change to or from NULL still counts
--
-- ⚠️ DROP THEN CREATE, NOT AN OVERLOAD. Adding four defaulted parameters under the same name
-- would leave two functions, and every existing 6-argument call would then match BOTH and
-- fail as ambiguous rather than picking one. Dropping first means the 10-argument version
-- with defaults is the only one, and a 6-argument caller still resolves to it unchanged --
-- which matters because the edge function deploys separately from this migration and will
-- keep making 6-argument calls until it does. Atomic inside the transaction.

begin;

drop function if exists public.crm_update_contact(text, uuid, text, text, text, uuid);

create or replace function public.crm_update_contact(
  p_client_id text,
  p_id uuid,
  p_name text default null,
  p_phone text default null,
  p_email text default null,
  p_actor uuid default null,
  p_street text default null,
  p_city text default null,
  p_state text default null,
  p_zip text default null
) returns integer
language plpgsql
security definer
set search_path to ''
as $function$
declare
  v_old    public.crm_contacts%rowtype;
  v_name   text;
  v_phone  text;
  v_email  text;
  v_digits text;
  v_street text;
  v_city   text;
  v_state  text;
  v_zip    text;
  v_n      integer := 0;
begin
  select * into v_old from public.crm_contacts
   where id = p_id and client_id = p_client_id;
  if not found then
    raise exception 'contact not found' using errcode = 'no_data_found';
  end if;

  -- btrim so a field of spaces reads as "cleared" rather than as a value made of spaces.
  v_name   := case when p_name   is null then v_old.name   else nullif(btrim(p_name), '')   end;
  v_phone  := case when p_phone  is null then v_old.phone  else nullif(btrim(p_phone), '')  end;
  v_email  := case when p_email  is null then v_old.email  else nullif(btrim(p_email), '')  end;
  v_street := case when p_street is null then v_old.street else nullif(btrim(p_street), '') end;
  v_city   := case when p_city   is null then v_old.city   else nullif(btrim(p_city), '')   end;
  v_state  := case when p_state  is null then v_old.state  else nullif(btrim(p_state), '')  end;
  v_zip    := case when p_zip    is null then v_old.zip    else nullif(btrim(p_zip), '')    end;
  v_digits := public.crm_phone_key(v_phone);

  -- One row per field that genuinely moved. `is distinct from` rather than `<>` so a change
  -- to or from NULL counts -- clearing an email is exactly the kind of edit somebody will
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
  -- The address fields log exactly like the first three. A delivery going to the wrong
  -- street because somebody quietly corrected it is precisely the edit a changelog is for.
  if v_street is distinct from v_old.street then
    insert into public.crm_field_changes (client_id, contact_id, field, old_value, new_value, changed_by)
    values (p_client_id, p_id, 'street', v_old.street, v_street, p_actor);
    v_n := v_n + 1;
  end if;
  if v_city is distinct from v_old.city then
    insert into public.crm_field_changes (client_id, contact_id, field, old_value, new_value, changed_by)
    values (p_client_id, p_id, 'city', v_old.city, v_city, p_actor);
    v_n := v_n + 1;
  end if;
  if v_state is distinct from v_old.state then
    insert into public.crm_field_changes (client_id, contact_id, field, old_value, new_value, changed_by)
    values (p_client_id, p_id, 'state', v_old.state, v_state, p_actor);
    v_n := v_n + 1;
  end if;
  if v_zip is distinct from v_old.zip then
    insert into public.crm_field_changes (client_id, contact_id, field, old_value, new_value, changed_by)
    values (p_client_id, p_id, 'zip', v_old.zip, v_zip, p_actor);
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
         street = v_street,
         city = v_city,
         state = v_state,
         zip = v_zip,
         updated_at = now()
   where id = p_id and client_id = p_client_id;

  return v_n;
end
$function$;

-- Same posture as every other SECURITY DEFINER function here: revoke from PUBLIC as well as
-- from the roles, because the PUBLIC grant survives revoking anon/authenticated and this one
-- writes another tenant's contacts if handed their client_id.
revoke execute on function public.crm_update_contact(text, uuid, text, text, text, uuid, text, text, text, text) from public, anon, authenticated;
grant  execute on function public.crm_update_contact(text, uuid, text, text, text, uuid, text, text, text, text) to service_role;

commit;
