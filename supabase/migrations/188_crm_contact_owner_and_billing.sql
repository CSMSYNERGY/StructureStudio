-- 188_crm_contact_owner_and_billing.sql — the contact editor gains an OWNER and a second
-- address, and the changelog finally has an owner change to log.
--
-- ── WHY OWNER (Carolyn, 2026-09-04 call, 1:09:30–1:10:46) ────────────────────────────────
-- "we do not ever assign deals. We only assign contacts and followers … if they are not
-- assigned to or following that customer, they can't see anything of it." Assignment is a
-- property of the PERSON, not of the quote — which is exactly the column 130 shipped and
-- then left inert.
--
-- 130 called owner_user_id "Pipedrive header furniture" and rendered it READ-ONLY "until
-- there is an editor". 143 built the editor for name/phone/email, 166 added the address, and
-- neither touched this column: it has had zero readers and zero writers since the day it was
-- created. This is the writer. The picker that calls it is a different worker's file.
--
-- ⚠️ THIS PAYS A DEBT THAT IS WRITTEN DOWN. _shared/crmFeed.ts's changelog comment has said
-- since 2026-08-26: "STILL NOT LOGGED: owner and assignee changes … When an owner picker
-- lands, it owes this list its event." It is paid here (the crm_field_changes row below) and
-- in that file (the owner_change type). Both halves or neither: a picker that writes the
-- column without the changelog row rebuilds the empty-changelog complaint that started this
-- whole thread.
--
-- ── WHY BILLING (same call) ──────────────────────────────────────────────────────────────
-- A customer's building goes to one address and their paperwork goes to another — a job site
-- versus a house, a rented lot versus a home address. crm_contacts has carried exactly one
-- flat address since 130.
--
-- ⚠️ THE EXISTING FOUR COLUMNS ARE THE DELIVERY ADDRESS AND MUST STAY THAT WAY. They are
-- populated from what the customer typed in the designer, and the delivery scheduler's
-- notion of a destination is built from those same submitted values (portal-schedule reads
-- them out of the designs.contact jsonb through _shared/contactAddress.ts). Renaming these
-- four, or quietly repurposing them as billing, would re-aim deliveries. So billing is FOUR
-- NEW COLUMNS and the old four are only commented, never moved.
--
-- ── WHY ONE FILE FOR TWO CHANGES ─────────────────────────────────────────────────────────
-- Both edit crm_update_contact, which is a DROP-then-CREATE (see 166's header for why an
-- overload is not an option). Splitting them across two migrations means writing the same
-- 200-line body twice in one deploy and leaving behind an intermediate signature that exists
-- for the length of one statement and is never called by anything. One drop, one create.
--
-- ⚠️ SIGNATURE GROWTH IS APPEND-ONLY, and that is load-bearing exactly as it was in 166: the
-- five new parameters go at the END with defaults, so the 6-argument calls of 143 and the
-- 10-argument calls of 166 keep resolving to this one function. portal-settings deploys
-- separately from this migration and will make 10-argument calls until it does.
--
-- HAND-APPLY (inline, not --file: `supabase db query --file` auth-fails, retries and still
-- exits 0), as the one begin/commit below, then record in
-- supabase_migrations.schema_migrations. Do NOT db push. BOM-free.
--
-- Rollback:
--   alter table public.crm_contacts
--     drop column if exists billing_street, drop column if exists billing_city,
--     drop column if exists billing_state,  drop column if exists billing_zip;
--   drop function if exists public.crm_update_contact(text, uuid, text, text, text, uuid, text, text, text, text, text, text, text, text, text);
--   -- then re-create 166's 10-argument version verbatim.
--   owner_user_id is deliberately NOT dropped: it predates this file, and a stored assignment
--   is real data. The crm_field_changes rows stay too — they are the record that it happened.

begin;

-- ─────────────────────────────────────────────────────────────────────────────────────────
-- PART 1 — the columns.
-- ─────────────────────────────────────────────────────────────────────────────────────────

alter table public.crm_contacts
  add column if not exists billing_street text,
  add column if not exists billing_city   text,
  add column if not exists billing_state  text,
  add column if not exists billing_zip    text;

-- Say out loud, in the database, which address is which. The four unprefixed columns have
-- always MEANT delivery; nothing recorded it, and the first person to add a second address
-- was always going to have to guess.
comment on column public.crm_contacts.street is
  'DELIVERY address. Populated from what the customer typed in the designer; a delivery stop''s '
  'destination is resolved from those same submitted values. NOT the billing address — that is '
  'billing_street (migration 188).';
comment on column public.crm_contacts.billing_street is
  'BILLING / mailing address, entered by the builder. Never written by a design submission and '
  'never read by the delivery scheduler (migration 188).';

comment on column public.crm_contacts.owner_user_id is
  'The team member this CONTACT is assigned to (Carolyn 2026-09-04: "we do not ever assign deals. '
  'We only assign contacts and followers"). A client_users.user_id on the same tenant, enforced by '
  'crm_update_contact. Writable since migration 188; every change lands in crm_field_changes under '
  'field = ''owner''.';

-- ─────────────────────────────────────────────────────────────────────────────────────────
-- PART 2 — the editor.
-- ─────────────────────────────────────────────────────────────────────────────────────────
--
-- Same three rules 143 established and 166 extended, and the owner obeys them too:
--   * NULL      => this field is not being edited, keep what is there
--   * ''        => a deliberate clear (for the owner: UNASSIGN)
--   * value     => set it
--   * changed   => one crm_field_changes row per field that genuinely moved, `is distinct
--                  from` so a change to or from NULL still counts
--
-- ⚠️ THE OWNER PARAMETER IS text, NOT uuid, AND THE CONTRACT IS WHY. A uuid cannot carry the
-- empty string, so a uuid parameter can express "leave alone" and "set" but not "unassign" —
-- the three-state contract would quietly collapse to two and unassigning a contact would be
-- impossible through the one write path that logs. It is parsed and cast below, so a
-- malformed value raises instead of silently doing nothing.

drop function if exists public.crm_update_contact(text, uuid, text, text, text, uuid, text, text, text, text);

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
  p_zip text default null,
  p_owner text default null,
  p_billing_street text default null,
  p_billing_city text default null,
  p_billing_state text default null,
  p_billing_zip text default null
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
  v_owner_txt text;
  v_owner  uuid;
  v_bstreet text;
  v_bcity   text;
  v_bstate  text;
  v_bzip    text;
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
  v_bstreet := case when p_billing_street is null then v_old.billing_street else nullif(btrim(p_billing_street), '') end;
  v_bcity   := case when p_billing_city   is null then v_old.billing_city   else nullif(btrim(p_billing_city), '')   end;
  v_bstate  := case when p_billing_state  is null then v_old.billing_state  else nullif(btrim(p_billing_state), '')  end;
  v_bzip    := case when p_billing_zip    is null then v_old.billing_zip    else nullif(btrim(p_billing_zip), '')    end;
  v_digits := public.crm_phone_key(v_phone);

  -- THE OWNER. '' unassigns; anything else must parse as a uuid AND name somebody on THIS
  -- tenant's team.
  --
  -- ⚠️ THE MEMBERSHIP CHECK IS NOT TIDINESS. Carolyn's rule is that assignment is what makes
  -- a record visible at all -- "if they are not assigned to or following that customer, they
  -- can't see anything of it" -- so owner_user_id is on its way to being an access input,
  -- not a label. A uuid belonging to another tenant, stored here by a typo, would be a
  -- permission handed to a stranger with nothing anywhere to notice. client_users' primary
  -- key is user_id, so this costs one index lookup.
  if p_owner is null then
    v_owner := v_old.owner_user_id;
  else
    v_owner_txt := nullif(btrim(p_owner), '');
    if v_owner_txt is null then
      v_owner := null;                          -- deliberate unassign
    else
      begin
        v_owner := v_owner_txt::uuid;
      exception when others then
        raise exception 'owner must be a user id' using errcode = 'invalid_text_representation';
      end;
      if not exists (select 1 from public.client_users cu
                      where cu.user_id = v_owner and cu.client_id = p_client_id) then
        raise exception 'owner is not on this team' using errcode = 'foreign_key_violation';
      end if;
    end if;
  end if;

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
  -- BILLING. Four more of the same, under their own field names so the changelog can say
  -- WHICH address moved -- "Street changed" on a record carrying two of them is not an answer.
  if v_bstreet is distinct from v_old.billing_street then
    insert into public.crm_field_changes (client_id, contact_id, field, old_value, new_value, changed_by)
    values (p_client_id, p_id, 'billing_street', v_old.billing_street, v_bstreet, p_actor);
    v_n := v_n + 1;
  end if;
  if v_bcity is distinct from v_old.billing_city then
    insert into public.crm_field_changes (client_id, contact_id, field, old_value, new_value, changed_by)
    values (p_client_id, p_id, 'billing_city', v_old.billing_city, v_bcity, p_actor);
    v_n := v_n + 1;
  end if;
  if v_bstate is distinct from v_old.billing_state then
    insert into public.crm_field_changes (client_id, contact_id, field, old_value, new_value, changed_by)
    values (p_client_id, p_id, 'billing_state', v_old.billing_state, v_bstate, p_actor);
    v_n := v_n + 1;
  end if;
  if v_bzip is distinct from v_old.billing_zip then
    insert into public.crm_field_changes (client_id, contact_id, field, old_value, new_value, changed_by)
    values (p_client_id, p_id, 'billing_zip', v_old.billing_zip, v_bzip, p_actor);
    v_n := v_n + 1;
  end if;
  -- THE OWNER CHANGE — the event _shared/crmFeed.ts has been owed since 2026-08-26.
  -- Stored as the two uuids; crmFeed resolves them to names against client_users, because
  -- "0f3c... -> 8a12..." answers none of the questions somebody opens a changelog to ask.
  if v_owner is distinct from v_old.owner_user_id then
    insert into public.crm_field_changes (client_id, contact_id, field, old_value, new_value, changed_by)
    values (p_client_id, p_id, 'owner', v_old.owner_user_id::text, v_owner::text, p_actor);
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
         owner_user_id = v_owner,
         billing_street = v_bstreet,
         billing_city = v_bcity,
         billing_state = v_bstate,
         billing_zip = v_bzip,
         updated_at = now()
   where id = p_id and client_id = p_client_id;

  return v_n;
end
$function$;

-- Same posture as every other SECURITY DEFINER function here: revoke from PUBLIC as well as
-- from the roles, because the PUBLIC grant survives revoking anon/authenticated and this one
-- writes another tenant's contacts if handed their client_id.
revoke execute on function public.crm_update_contact(text, uuid, text, text, text, uuid, text, text, text, text, text, text, text, text, text) from public, anon, authenticated;
grant  execute on function public.crm_update_contact(text, uuid, text, text, text, uuid, text, text, text, text, text, text, text, text, text) to service_role;

-- ─────────────────────────────────────────────────────────────────────────────────────────
-- PART 3 — apply-time assertions. They RAISE, which aborts the transaction and takes PARTS
--          1-2 with it. Both failures below are silent at runtime.
-- ─────────────────────────────────────────────────────────────────────────────────────────

do $$
declare
  v_overloads int;
begin
  -- Exactly ONE crm_update_contact. Two would make every existing 10-argument named call
  -- ambiguous rather than resolving to the newer one -- 166's whole reason for dropping
  -- first, and the result is a 500 on save, not a warning.
  select count(*) into v_overloads from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'crm_update_contact';
  if v_overloads <> 1 then
    raise exception 'crm_update_contact: expected exactly 1 overload, found %', v_overloads;
  end if;

  if (select count(*) from information_schema.columns
       where table_schema = 'public' and table_name = 'crm_contacts'
         and column_name in ('billing_street','billing_city','billing_state','billing_zip')) <> 4 then
    raise exception 'crm_contacts: the four billing columns did not land';
  end if;
end
$$;

commit;
