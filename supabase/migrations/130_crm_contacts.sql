-- 130_crm_contacts.sql — give a contact a real identity, so notes and activity can hang off it.
--
-- WHY NOW. Carolyn, 2026-08-24, after walking Pipedrive live: "the view of being in an
-- opportunity and the view of being in a person are different, but they're the same" and
-- "these two need to be consolidated". That layout hangs notes, activities, an owner and a
-- timeline off A PERSON. Today a contact is not a row — LeadsTable derives one client-side
-- by grouping designs.
--
-- WHY THE DERIVED KEY CANNOT CARRY IT. The grouping key in portal/02-sales.jsx is a
-- FALLTHROUGH: phone_digits || email || name || short_code. It is not stable.
--   * A contact whose first design carried no phone keys on EMAIL. Their second design
--     carries a phone, so the key becomes the PHONE — and every note, activity and owner
--     assignment hung off the old key orphans silently.
--   * captured_leads keys on phone_digits only (062), while the suppression logic matches
--     phone-then-email. Two different match orders on two sides of the same join.
--   * A contact with no phone, no email and no name keys on short_code — a per-design
--     "contact" you cannot hang a person-level note on at all.
-- A key that can change under the data is not a foundation; it is a bug with a delay fuse.
--
-- WHY NO TRIGGER ON `designs`. That is the product's most critical table and it is
-- pre-repo. A resolver exception on a trigger becomes "the customer's design would not
-- save". Unnecessary too: EVERY design write goes through public.save_design — the anon
-- designer, the in-portal designer and the operator console all call the same RPC — so
-- there is exactly one place to hook. See the splice instructions at the bottom.
--
-- SCOPE. Inert on apply. Nothing selects crm_contacts and designs.contact_id is a nullable
-- column no query mentions until the portal ships.
--
-- Rollback:
--   alter table public.designs        drop column if exists contact_id;
--   alter table public.captured_leads drop column if exists contact_id;
--   drop function if exists public.crm_ensure_contact(text, text, text, text);
--   drop table if exists public.crm_contacts;
--   (and remove the guarded block from save_design — regenerate from the LIVE body)

create table if not exists public.crm_contacts (
  id           uuid primary key default gen_random_uuid(),
  client_id    text not null,
  name         text,
  phone        text,                       -- as typed, for display
  phone_digits text,                       -- normalized; the primary match key
  email        text,
  email_lower  text generated always as (lower(btrim(email))) stored,
  street text, city text, state text, zip text,
  -- Pipedrive header furniture. Shipped now and rendered READ-ONLY until there is an
  -- editor: the columns are the infrastructure Carolyn asked for, and adding them later
  -- would mean a second migration against a table the portal is already reading.
  owner_user_id uuid,
  labels        text[] not null default '{}',
  -- Merge tombstone. A merged contact is never deleted, so a note can never orphan.
  merged_into  uuid references public.crm_contacts(id),
  source       text not null default 'design'
                 check (source in ('design','captured_lead','manual','import')),
  first_seen_at timestamptz not null default now(),
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

-- Two partial unique match keys, mirroring the fallthrough order the app already uses.
-- Email uniqueness applies ONLY when there is no phone, so a person known by both does not
-- collide with themselves.
create unique index if not exists crm_contacts_tenant_phone
  on public.crm_contacts (client_id, phone_digits)
  where phone_digits is not null and phone_digits <> '' and merged_into is null;
create unique index if not exists crm_contacts_tenant_email
  on public.crm_contacts (client_id, email_lower)
  where (phone_digits is null or phone_digits = '')
    and email_lower is not null and email_lower <> '' and merged_into is null;
create index if not exists crm_contacts_client_recent
  on public.crm_contacts (client_id, updated_at desc);

alter table public.crm_contacts enable row level security;
-- A new table ships world-readable; 112's whole point. Revoke, then grant back exactly
-- what the portal needs — and nothing more. Writes go through the resolver or service role.
revoke all on public.crm_contacts from anon, authenticated;
grant select on public.crm_contacts to authenticated;
drop policy if exists crm_contacts_owner_select on public.crm_contacts;
create policy crm_contacts_owner_select on public.crm_contacts
  for select to authenticated using (client_id = public.current_client_id());

alter table public.designs        add column if not exists contact_id uuid;
alter table public.captured_leads add column if not exists contact_id uuid;
-- No FK on designs.contact_id, on purpose: it keeps the backfill and the live write path
-- decoupled, the same way orders.short_code is a soft link.
create index if not exists designs_contact_idx
  on public.designs (client_id, contact_id) where contact_id is not null;

-- ─────────────────────────────────────────────────────────────────────────────
-- The resolver. Idempotent, advisory-locked, enrich-never-blank.
-- ─────────────────────────────────────────────────────────────────────────────
create or replace function public.crm_ensure_contact(
  p_client_id text, p_name text, p_phone text, p_email text
) returns uuid
language plpgsql security definer set search_path to ''
as $fn$
declare
  v_digits text := nullif(regexp_replace(coalesce(p_phone, ''), '\D', '', 'g'), '');
  v_email  text := nullif(lower(btrim(coalesce(p_email, ''))), '');
  v_id uuid;
begin
  -- No identity, no row. A design with neither a phone nor an email is a browsing artefact,
  -- not a person, and inventing a contact for it is how a Contacts list fills with ghosts.
  if v_digits is null and v_email is null then return null; end if;

  -- Serialize concurrent resolution of ONE identity. Two designs submitted at the same
  -- second by the same person would otherwise both miss the select and both insert, and
  -- one would lose to the unique index. Same pattern as the change_orders guard.
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
    -- ENRICH, NEVER BLANK: the newest non-empty value wins and an empty one never clears a
    -- stored one. Exactly the rule LeadsTable already applies in memory, moved to where it
    -- can be relied on. Without it, a customer who submits a second design without
    -- re-typing their email silently loses the email we already had.
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

-- Callable only from save_design (itself SECURITY DEFINER, so it runs as the owner) and
-- from the service role. The anon designer never calls it directly.
revoke execute on function public.crm_ensure_contact(text, text, text, text)
  from public, anon, authenticated;

-- ─────────────────────────────────────────────────────────────────────────────
-- BACKFILL. Idempotent and re-runnable; oldest first so first_seen_at lands right and the
-- newest non-empty value wins last.
-- ─────────────────────────────────────────────────────────────────────────────
do $$
declare r record; v uuid;
begin
  for r in select short_code, client_id, contact, created_at
             from public.designs
            where contact_id is null and coalesce(status, '') <> 'inventory'
            order by created_at asc
  loop
    v := public.crm_ensure_contact(r.client_id, r.contact->>'name', r.contact->>'phone', r.contact->>'email');
    if v is not null then
      update public.designs set contact_id = v where short_code = r.short_code;
      update public.crm_contacts set first_seen_at = least(first_seen_at, r.created_at) where id = v;
    end if;
  end loop;

  for r in select id, client_id, name, phone, email, created_at
             from public.captured_leads
            where contact_id is null
            order by created_at asc
  loop
    v := public.crm_ensure_contact(r.client_id, r.name, r.phone, r.email);
    if v is not null then
      update public.captured_leads set contact_id = v where id = r.id;
      update public.crm_contacts
         set first_seen_at = least(first_seen_at, r.created_at),
             source = 'captured_lead'
       where id = v and source = 'design';
    end if;
  end loop;
end $$;

-- ─────────────────────────────────────────────────────────────────────────────
-- 🚨 MANUAL STEP — SPLICE INTO save_design. DO NOT SKIP, DO NOT AUTOMATE FROM THE REPO.
-- ─────────────────────────────────────────────────────────────────────────────
-- save_design as it exists in 002_design_rpcs.sql IS NOT WHAT IS LIVE. It was replaced
-- wholesale by 111_save_design_protect_invoiced, whose own header says the repo copy of a
-- wholesale-replaced function is never proof. Rebuilding it from 002 would silently
-- un-ship 031's version snapshot, 104's inventory-master protection and 111's invoiced
-- protection — the exact class of accident migration 110 documents for get_config.
--
-- Procedure:
--   1. select pg_get_functiondef('public.save_design'::regproc);
--   2. Paste that body into an editor.
--   3. Immediately AFTER the row is upserted and returned into its record variable, insert
--      the guarded block below.
--   4. Diff old vs new. The ONLY difference must be that block.
--   5. Apply, then submit one real design on an internal tenant with beta mode + a test
--      inbox and confirm a crm_contacts row appeared and designs.contact_id is stamped.
--
--   -- CRM bookkeeping must NEVER be able to fail a customer's design save. If the resolver
--   -- throws for any reason, the design still saves and contact_id stays null; the backfill
--   -- above is re-runnable and will pick it up. Same contract as qboInvoice/emailSend.
--   begin
--     update public.designs
--        set contact_id = public.crm_ensure_contact(
--              p_client_id, p_contact->>'name', p_contact->>'phone', p_contact->>'email')
--      where short_code = p_code and contact_id is null;
--   exception when others then
--     null;
--   end;
--
-- PROVE THE GUARD before trusting it: inside a transaction, revoke execute on
-- crm_ensure_contact from the definer's role, submit a design, confirm it STILL SAVES with
-- contact_id null, then roll back.
--
-- capture-lead also gets the same stamp after its captured_leads upsert (service role, so
-- it calls the function directly).
