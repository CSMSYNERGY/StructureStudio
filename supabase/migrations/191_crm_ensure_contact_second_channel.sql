-- 191_crm_ensure_contact_second_channel.sql — a second email stops being thrown away.
--
-- ── WHY (Carolyn, 2026-09-04 call) ───────────────────────────────────────────────────────
-- "If it's the same phone number, and you give a second email address, it will stay with that
-- one, and it'll just add a second email address in. And the same thing … if the email
-- address is already in, and they get a second phone number, it stays with it."
--
-- ── WHAT IT DOES TODAY, WHICH IS NOT THAT ────────────────────────────────────────────────
-- 132's resolver matches phone-then-email and then enriches with
-- `coalesce(nullif(btrim(new), ''), old)`. Read that against a MATCHED row and it says: the
-- newest non-empty value wins. So on a contact that already has both channels:
--
--   * a new, DIFFERENT email is discarded outright — coalesce takes the new one, the update
--     overwrites the stored one, and the address we already had is gone;
--   * a new, DIFFERENT phone does the same to phone AND to phone_digits, which is worse than
--     discarding: phone_digits is the primary match key, so the contact stops matching their
--     own history and the old number is not recorded anywhere. If that number happens to
--     belong to another contact it is not even an overwrite — it is a unique violation on
--     crm_contacts_tenant_phone, raised inside the block save_design swallows, and the only
--     symptom is a design whose contact_id is silently null.
--
-- 130's comment for that rule is quoted often and is still right about the case it was
-- written for: "a customer who submits a second design without re-typing their email silently
-- loses the email we already had". It was reasoning about a MISSING value, and it is correct
-- there — an empty field must never clear a stored one, and that behaviour is untouched
-- below. It simply never distinguished missing from DIFFERENT, and a different value is not
-- an enrichment, it is a second person or a second address. Both belong on the record.
--
-- ── THE RULE THIS FILE INSTALLS ──────────────────────────────────────────────────────────
--   arriving value is empty        -> keep what is stored          (unchanged, 130's rule)
--   stored value is empty          -> store the arriving one       (unchanged, 130's rule)
--   both present and DIFFERENT     -> keep the stored one, and land the arriving one as a
--                                     row in crm_contact_people (190)
--
-- and the match now searches BOTH tables, so the second channel is not merely stored, it
-- RESOLVES: the next design carrying only the wife's email finds the husband's record.
--
-- ⚠️ TWO PROPERTIES ARE LOAD-BEARING AND SURVIVE VERBATIM.
--   1. pg_advisory_xact_lock, keyed exactly as before. Two designs submitted in the same
--      second by the same person would otherwise both miss the select and both insert, and
--      one would lose to the unique index (130's note; same pattern as the change_orders
--      guard). The key is still coalesce(digits, email) — NOT widened to include the new
--      lookups, because a lock is only useful if every racer computes the same key from the
--      same identity, and both racers here are the same identity by definition.
--   2. "no phone AND no email -> return NULL, create nothing". 130's header: a design with
--      neither is a browsing artefact, not a person, and inventing a contact for it is how a
--      Contacts list fills with ghosts. It is still the first statement in the body.
--
-- HAND-APPLY (inline, not --file: `supabase db query --file` auth-fails, retries and still
-- exits 0), then record in supabase_migrations.schema_migrations. Do NOT db push. BOM-free.
-- Requires 190 (crm_contact_people) to be applied FIRST.
--
-- Rollback: re-create crm_ensure_contact from 132 verbatim. Rows already written to
-- crm_contact_people are left alone — they are real data about real customers, and the old
-- resolver simply stops looking at them.

begin;

create or replace function public.crm_ensure_contact(
  p_client_id text, p_name text, p_phone text, p_email text
) returns uuid
language plpgsql security definer set search_path to ''
as $fn$
declare
  v_digits text := public.crm_phone_key(p_phone);
  v_email  text := nullif(lower(btrim(coalesce(p_email, ''))), '');
  v_name   text := nullif(btrim(coalesce(p_name, '')), '');
  v_id     uuid;
  v_old    public.crm_contacts%rowtype;
  v_person public.crm_contact_people%rowtype;
  v_have_person boolean := false;
  v_phone_conflict boolean := false;
  v_email_conflict boolean := false;
  v_ordinal integer;
begin
  -- No identity, no row. See the header: this guard is why the Contacts list is not full of
  -- ghosts, and nothing below is allowed to move it.
  if v_digits is null and v_email is null then return null; end if;

  -- Serialize concurrent resolution of ONE identity. Unchanged from 130/132, key included.
  perform pg_advisory_xact_lock(
    hashtext('ss_crm_contact:' || p_client_id || ':' || coalesce(v_digits, v_email)));

  -- ── MATCHING: phone beats email, and each channel checks the parent before the children ──
  -- The order is 130's documented fallthrough (phone, then email) with the second table
  -- interleaved beneath each channel rather than appended after both. Appending would let a
  -- stale email on a parent row outrank an exact phone match on a person row, which inverts
  -- the priority the whole schema is built on: a phone is the primary match key precisely
  -- because it is the one people do not share.
  --
  -- Every lookup is ordered and limited. The parent's email index is PARTIAL (unique only
  -- where there is no phone — 130:65), so an email lookup can legitimately see more than one
  -- row, and `select ... into` without an order takes whichever the plan happens to yield
  -- first. That was already true before this file; making the four lookups agree on "oldest
  -- wins" costs nothing and removes a result that can change between two identical calls.
  if v_digits is not null then
    select c.id into v_id from public.crm_contacts c
     where c.client_id = p_client_id and c.phone_digits = v_digits and c.merged_into is null
     order by c.first_seen_at, c.id limit 1;
  end if;
  if v_id is null and v_digits is not null then
    select p.contact_id into v_id
      from public.crm_contact_people p
      join public.crm_contacts c on c.id = p.contact_id
     where p.client_id = p_client_id and p.phone_digits = v_digits
       and c.client_id = p_client_id and c.merged_into is null
     order by p.created_at, p.id limit 1;
  end if;
  if v_id is null and v_email is not null then
    select c.id into v_id from public.crm_contacts c
     where c.client_id = p_client_id and c.email_lower = v_email and c.merged_into is null
     order by c.first_seen_at, c.id limit 1;
  end if;
  if v_id is null and v_email is not null then
    select p.contact_id into v_id
      from public.crm_contact_people p
      join public.crm_contacts c on c.id = p.contact_id
     where p.client_id = p_client_id and p.email_lower = v_email
       and c.client_id = p_client_id and c.merged_into is null
     order by p.created_at, p.id limit 1;
  end if;

  if v_id is null then
    insert into public.crm_contacts (client_id, name, phone, phone_digits, email)
      values (p_client_id, v_name, p_phone, v_digits, p_email)
      returning id into v_id;
    return v_id;
  end if;

  select * into v_old from public.crm_contacts where id = v_id;

  -- A CONFLICT IS: both sides present, and different. Missing on either side is enrichment,
  -- which is 130's rule and is left exactly as it was.
  v_phone_conflict := v_digits is not null
                      and coalesce(v_old.phone_digits, '') <> ''
                      and v_old.phone_digits <> v_digits;
  v_email_conflict := v_email is not null
                      and coalesce(v_old.email_lower, '') <> ''
                      and v_old.email_lower <> v_email;

  -- ENRICH, NEVER BLANK — and now, never CLOBBER either. A conflicting channel leaves the
  -- parent's stored value untouched; it is recorded below instead.
  --
  -- The name follows the conflicting channel rather than the parent. When the wife submits
  -- her own quote on the family's phone, "newest non-empty name wins" quietly renames the
  -- record to her — the husband's name is not enriched by it, it is replaced by it. With a
  -- conflict present we already know this is a second person, so her name belongs on her row.
  update public.crm_contacts set
    name         = case when v_phone_conflict or v_email_conflict then name
                        else coalesce(v_name, name) end,
    phone        = case when v_phone_conflict then phone
                        else coalesce(nullif(btrim(coalesce(p_phone, '')), ''), phone) end,
    phone_digits = case when v_phone_conflict then phone_digits
                        else coalesce(v_digits, phone_digits) end,
    email        = case when v_email_conflict then email
                        else coalesce(nullif(btrim(coalesce(p_email, '')), ''), email) end,
    updated_at   = now()
  where id = v_id;

  if not (v_phone_conflict or v_email_conflict) then
    return v_id;
  end if;

  -- ── The second person / second channel ─────────────────────────────────────────────────
  -- Look for a row on THIS record that already holds one of the arriving channels before
  -- inserting, because a design is re-saved on every edit: without this, one customer with
  -- two email addresses would grow a person row per save.
  select * into v_person from public.crm_contact_people p
   where p.contact_id = v_id
     and ( (v_phone_conflict and p.phone_digits = v_digits)
        or (v_email_conflict and p.email_lower = v_email) )
   order by p.created_at, p.id limit 1;
  v_have_person := found;

  select coalesce(max(p.ordinal), 1) + 1 into v_ordinal
    from public.crm_contact_people p where p.contact_id = v_id;

  -- ⚠️ THE WHOLE WRITE IS GUARDED, AND ONLY AGAINST unique_violation. The two partial unique
  -- indexes on crm_contact_people are per-contact (190 PART 2 explains why they are not
  -- tenant-wide), and there is one arrangement they can still refuse: the arriving phone
  -- already sits on one person row of this record and the arriving email on a DIFFERENT one,
  -- so enriching either would make it collide with the other. Both values are already
  -- recorded on the record in that case, which is what this function exists to guarantee, so
  -- the right answer is to stop rather than to raise — a raise here reaches save_design,
  -- which swallows it, and the customer's design loses its contact link over a duplicate we
  -- did not need to write. Everything else still propagates: a missing table, a revoked
  -- grant or a broken constraint must NOT be silently absorbed here.
  begin
    if v_have_person then
      update public.crm_contact_people set
        name  = coalesce(name, v_name),
        phone = case when v_phone_conflict then coalesce(phone, p_phone) else phone end,
        email = case when v_email_conflict then coalesce(email, p_email) else email end
      where id = v_person.id;
    else
      insert into public.crm_contact_people
        (client_id, contact_id, ordinal, name, phone, email, source)
      values (p_client_id, v_id, coalesce(v_ordinal, 2), v_name,
              case when v_phone_conflict then p_phone else null end,
              case when v_email_conflict then p_email else null end,
              'design');
    end if;
  exception when unique_violation then
    null;
  end;

  return v_id;
end $fn$;

-- Callable only from save_design and capture-lead (both of which reach it as the definer or
-- the service role) — never from a browser. Re-issued because 132 issued it and a reader
-- comparing the two files should not have to infer that CREATE OR REPLACE kept the grants.
revoke execute on function public.crm_ensure_contact(text, text, text, text)
  from public, anon, authenticated;

commit;

-- ─────────────────────────────────────────────────────────────────────────────────────────
-- WHAT THIS DOES NOT DO, so nobody goes looking for it.
-- ─────────────────────────────────────────────────────────────────────────────────────────
-- * It does not backfill. Every email and phone discarded between 130 and today is gone from
--   crm_contacts — the update overwrote them — and there is no second copy to recover: the
--   raw submission survives in designs.contact and captured_leads, so a backfill IS possible,
--   but it is a judgement about live customer records and belongs in its own migration with
--   its own human reading it (132 made the same call about its two duplicate pairs).
-- * It does not teach the OTHER matchers about crm_contact_people. sms-inbound and
--   email-inbound each resolve an incoming message to a contact with their own query against
--   crm_contacts. Until those learn this table, a reply from the wife's email address lands
--   unmatched rather than on the family's record — the inbound side degrades to what it does
--   today, which is exactly what it did before this file, so nothing regresses. Those are two
--   edge functions this change does not own.
