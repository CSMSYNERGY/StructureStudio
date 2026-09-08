-- 190_crm_contact_people.sql — one record, more than one human on it.
--
-- ── WHY (Carolyn, 2026-09-04 call, ~1:13:00) ─────────────────────────────────────────────
-- "This is name one and then the wife and then the phone number … it doesn't have to be
-- husband and wife, it can be two people buying, two business partners." Each with their OWN
-- phone and their OWN email.
--
-- crm_contacts holds exactly one name, one phone and one email, and its resolver is
-- enrich-never-blank — so today the second person's details either overwrite the first's or
-- are thrown away, depending on which field arrives. Migration 191 stops the throwing away;
-- this file is the place it puts them.
--
-- The parent row stays the record's identity. This table is ADDITIONAL people, not a
-- replacement for the parent's three columns: every reader in the product — the Contacts
-- list, the estimate, the delivery stop, the SMS and email matchers — reads the parent, and
-- moving the primary person into a child table would mean editing all of them at once for no
-- gain today.
--
-- ⚠️ READ 130:59-68 BEFORE TOUCHING THE INDEXES BELOW. The parent's two unique indexes are
-- ASYMMETRIC and PARTIAL on purpose: phone is unique per tenant ALWAYS, email is unique only
-- WHEN THERE IS NO PHONE. The consequence, and it is the whole reason the indexes here are
-- shaped the way they are: TWO CONTACTS MAY LEGALLY SHARE AN EMAIL as long as each has a
-- distinct phone. A tenant-wide unique index on this table's email would forbid what the
-- parent permits — the two would contradict, and the contradiction would surface as a failed
-- save inside crm_ensure_contact, which save_design swallows. See PART 2.
--
-- HAND-APPLY (inline, not --file: `supabase db query --file` auth-fails, retries and still
-- exits 0), then record in supabase_migrations.schema_migrations. Do NOT db push. BOM-free.
-- Inert on apply: nothing reads or writes this table until 191 lands.
--
-- Rollback:
--   drop table if exists public.crm_contact_people;
--   (191's resolver must come out first, or it will insert into a table that is gone —
--    inside a block save_design swallows, so the symptom would be contacts quietly losing
--    their second channel again.)

begin;

-- ─────────────────────────────────────────────────────────────────────────────────────────
-- PART 1 — the table.
-- ─────────────────────────────────────────────────────────────────────────────────────────
--
-- client_id is denormalized beside contact_id, as on crm_notes / crm_activities /
-- crm_field_changes: it is what every policy and index in this schema keys on.
--
-- email_lower is GENERATED and phone_digits is NOT, which mirrors the parent exactly (130:43
-- generates one and leaves the other). The asymmetry is not copied out of deference — the
-- trigger in PART 3 removes the hazard 143's header describes ("phone_digits HAS NO TRIGGER
-- AND IS NOT GENERATED … update `phone` without it and the contact silently stops matching")
-- while keeping the column ordinary data, so a future 132-style re-key is a plain UPDATE
-- here as it was there, instead of a table rewrite against a stored generated expression.

create table if not exists public.crm_contact_people (
  id           uuid primary key default gen_random_uuid(),
  client_id    text not null,
  contact_id   uuid not null references public.crm_contacts(id) on delete cascade,
  -- DISPLAY ORDER, and deliberately not an identity — see the index note in PART 2.
  ordinal      integer not null default 1,
  name         text,
  phone        text,                       -- as typed, for display
  phone_digits text,                       -- normalized by the trigger in PART 3
  email        text,
  email_lower  text generated always as (lower(btrim(email))) stored,
  -- Which of the people on this record is the one to call. Nothing sets it today: the
  -- parent's own columns ARE the primary, and this flag only becomes meaningful when the
  -- record page grows a "make this the main contact" control that swaps a child row into the
  -- parent. It is here rather than added later for 130's stated reason — a second migration
  -- against a table the portal is already reading is worse — and it is a FLAG rather than a
  -- reserved lookup table because crmFeed's own comment is right that a seam for a feature
  -- nobody intends to build is a misleading comment somebody eventually acts on. One boolean
  -- with an index enforcing "at most one" is small enough to be honest about.
  is_primary   boolean not null default false,
  source       text not null default 'design'
                 check (source in ('design','captured_lead','manual','import','merge')),
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  -- A person with neither a phone nor an email nor a name is nothing at all. Same instinct as
  -- crm_ensure_contact's "no identity, no row" guard, which exists because inventing people
  -- for browsing artefacts is how a Contacts list fills with ghosts.
  constraint crm_contact_people_identity
    check (coalesce(btrim(name), '') <> '' or coalesce(btrim(phone), '') <> ''
           or coalesce(btrim(email), '') <> '')
);

-- ─────────────────────────────────────────────────────────────────────────────────────────
-- PART 2 — the indexes, and why none of them is tenant-wide.
-- ─────────────────────────────────────────────────────────────────────────────────────────
--
-- UNIQUENESS IS PER CONTACT, NEVER PER TENANT. Three separate reasons, and each on its own is
-- enough:
--
--   1. IT WOULD CONTRADICT THE PARENT (130:65-68). Contact A (phone P1, email E) and contact
--      B (phone P2, same email E) are both legal today, because the parent's email index only
--      applies where there is no phone. A tenant-wide unique email here would make the second
--      of them unrepresentable the moment either gained a second channel.
--
--   2. IT WOULD REJECT A LEGITIMATE ARRIVAL. 191 lands a conflicting phone on whichever
--      contact the email matched. If that phone is already the PARENT phone of some other
--      contact, a tenant-wide index would raise — inside crm_ensure_contact, inside the block
--      save_design swallows. The visible symptom is a design whose contact_id is null, with
--      nothing anywhere saying why.
--
--   3. IT IS NOT NEEDED FOR MATCHING. 191 searches this table to FIND a contact; it does not
--      need the answer to be unique, only deterministic — it takes the oldest row. Two
--      contacts that genuinely end up holding the same channel are a duplicate pair, and this
--      schema already has an answer for those: merge them (192). Forbidding the state at
--      write time instead means the arriving customer is dropped rather than recorded.
--
-- What IS enforced per contact: the same person is not listed twice on one record.

create unique index if not exists crm_contact_people_phone_uniq
  on public.crm_contact_people (contact_id, phone_digits)
  where phone_digits is not null and phone_digits <> '';
create unique index if not exists crm_contact_people_email_uniq
  on public.crm_contact_people (contact_id, email_lower)
  where email_lower is not null and email_lower <> '';

-- ⚠️ ORDINAL IS INDEXED, NOT UNIQUE, AND THAT IS DELIBERATE. The obvious `unique
-- (contact_id, ordinal)` turns a race between two concurrent submissions for the same
-- customer into a unique violation raised inside crm_ensure_contact — which save_design
-- swallows, so the price of a tie in a DISPLAY ORDER would be a design that never gets linked
-- to its contact. created_at breaks ties for free and costs nothing when it is wrong.
create index if not exists crm_contact_people_order_idx
  on public.crm_contact_people (contact_id, ordinal, created_at);

-- At most one primary per record. Cheap to enforce, and the alternative — two rows both
-- claiming to be the person to call — is the kind of state that is only noticed by a customer
-- who did not get called.
create unique index if not exists crm_contact_people_primary_uniq
  on public.crm_contact_people (contact_id) where is_primary;

-- The resolver's two lookups (191). Non-unique by the reasoning above; they exist so
-- searching both tables costs an index probe rather than a scan of every extra person the
-- tenant has ever recorded.
create index if not exists crm_contact_people_tenant_phone_idx
  on public.crm_contact_people (client_id, phone_digits)
  where phone_digits is not null and phone_digits <> '';
create index if not exists crm_contact_people_tenant_email_idx
  on public.crm_contact_people (client_id, email_lower)
  where email_lower is not null and email_lower <> '';

comment on table public.crm_contact_people is
  'Additional humans on one contact record - a spouse, a business partner - each with their own '
  'phone and email (Carolyn 2026-09-04). The parent crm_contacts row remains the record identity; '
  'this is where a second channel lands instead of being discarded. Service-role writes only.';

-- ─────────────────────────────────────────────────────────────────────────────────────────
-- PART 3 — phone_digits derives itself.
-- ─────────────────────────────────────────────────────────────────────────────────────────
--
-- 132 extracted crm_phone_key precisely so the resolver, the backfill and any future writer
-- could not disagree about what "the same number" means, and 143 records what it costs when a
-- writer forgets: the contact silently stops matching their own next design. There will be
-- more writers of this table than of the parent (the resolver, the merge, and whatever
-- editor Carolyn gets next), so the derivation is enforced once here rather than trusted
-- three times.

create or replace function public.crm_contact_people_stamp()
returns trigger language plpgsql security definer set search_path to ''
as $fn$
begin
  new.phone_digits := public.crm_phone_key(new.phone);
  if tg_op = 'UPDATE' then
    new.created_at := old.created_at;
    new.updated_at := now();
  end if;
  return new;
end $fn$;

drop trigger if exists crm_contact_people_stamp on public.crm_contact_people;
create trigger crm_contact_people_stamp before insert or update on public.crm_contact_people
  for each row execute function public.crm_contact_people_stamp();

-- ─────────────────────────────────────────────────────────────────────────────────────────
-- PART 4 — posture. 130 / 131 / 143, plus the PUBLIC revoke.
-- ─────────────────────────────────────────────────────────────────────────────────────────
--
-- ⚠️ `from public` AS WELL AS from the two roles. Revoking anon and authenticated does not
-- touch a grant held by PUBLIC, which every role inherits, so a revoke naming only the roles
-- can leave the table readable by the very roles it just named.
--
-- No `contacts`-area policy, for 131's reason and 189's: nothing reads this table directly
-- from the browser, every read goes through portal-settings where the area is already
-- resolved, and a second copy of the permission model guarding nothing is exactly the drift
-- _shared/access.ts warns about. Add it in the commit that adds a direct browser read.
alter table public.crm_contact_people enable row level security;
revoke all on public.crm_contact_people from public, anon, authenticated;
grant select on public.crm_contact_people to authenticated;
drop policy if exists crm_contact_people_owner_select on public.crm_contact_people;
create policy crm_contact_people_owner_select on public.crm_contact_people
  for select to authenticated using (client_id = public.current_client_id());

revoke execute on function public.crm_contact_people_stamp() from public, anon, authenticated;

commit;
