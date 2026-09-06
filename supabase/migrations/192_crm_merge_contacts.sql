-- 192_crm_merge_contacts.sql — the button 132 said a human should press.
--
-- ── WHY ──────────────────────────────────────────────────────────────────────────────────
-- crm_contacts has carried `merged_into` since 130. Every read in the product filters on it
-- ("and merged_into is null"), every header calls it the merge tombstone — and NOTHING HAS
-- EVER SET IT. The column is a promise the schema has been making since the day it shipped.
-- 132 closes with "a human should press the button"; there is no button, and there is no
-- server behind one either. This is the server half.
--
-- ⚠️ READ 132:84-118 BEFORE USING THIS ON THE TWO PAIRS IT NAMES.
--
--   Nevin Friesen   "(170) 736-2566"   and, separately, "(707) 362-5667"
--   Izaak Neil      "(157) 350-8782"   and, separately, "(573) 508-7821"
--
-- Those are NOT a merge problem and merging them does not fix anything. Read the first of
-- each pair as digits — 1707362566 — and it is "+1 707 362 5667" run through a TEN-digit US
-- mask: the leading 1 was eaten as the start of the area code and THE LAST DIGIT WAS DROPPED.
-- The number is destroyed, not merely formatted oddly; the final digit exists nowhere in the
-- row. Both mangled values are already present in designs.contact, so it happened at CAPTURE
-- time, in whatever formats the phone field.
--
-- Merging those two rows HIDES that. It produces one tidy-looking contact, removes the pair
-- that made the defect visible, and leaves the formatter free to mint the next pair tomorrow
-- — with the evidence of the last one now folded away under a tombstone. So: fix the
-- formatter first, then merge. Finding them again costs one query (132 supplies it: a
-- ten-digit key beginning with 1 is impossible for a real NANP number).
--
-- The formatter is not touched here. It is a browser file this change does not own, and a
-- half-fix applied from the database side would leave two normalizers disagreeing, which is
-- the precise failure 132 extracted crm_phone_key to prevent.
--
-- ── POSTURE ──────────────────────────────────────────────────────────────────────────────
-- SECURITY DEFINER and revoked from public/anon/authenticated, exactly like
-- crm_update_contact: it rewrites another tenant's contacts if it is handed their client_id,
-- so the tenant is a parameter the edge function supplies from resolveTenant and never a
-- value a browser gets to choose. There is no `contacts`-area check in here for the same
-- reason 143 has none — RLS and SQL cannot express the area, portal-settings can, and
-- splitting one rule across two places is how permission models start lying.
--
-- HAND-APPLY (inline, not --file: `supabase db query --file` auth-fails, retries and still
-- exits 0), then record in supabase_migrations.schema_migrations. Do NOT db push. BOM-free.
-- Inert on apply — creating a function nobody calls changes no behaviour. Requires 188, 189
-- and 190.
--
-- Rollback:
--   drop function if exists public.crm_merge_contacts(text, uuid, uuid, uuid);
--   ⚠️ Dropping the function does NOT un-merge anything. merged_into records where each row
--   went and the re-pointed rows carry the winner's id; reversing one merge means walking
--   that id back by hand, which is why every step below is additive and nothing is deleted.

begin;

create or replace function public.crm_merge_contacts(
  p_client_id text,
  p_winner    uuid,
  p_loser     uuid,
  p_actor     uuid default null
) returns jsonb
language plpgsql
security definer
set search_path to ''
as $fn$
declare
  v_win   public.crm_contacts%rowtype;
  v_lose  public.crm_contacts%rowtype;
  v_moved jsonb := '{}'::jsonb;
  v_label text;
  v_n     integer;
  v_name  text;
  v_phone text;
  v_email text;
  v_street text; v_city text; v_state text; v_zip text;
  v_bstreet text; v_bcity text; v_bstate text; v_bzip text;
  v_owner uuid;
  v_p     public.crm_contact_people%rowtype;
  v_left  integer := 0;
  v_phone_conflict boolean := false;
  v_email_conflict boolean := false;
  v_name_conflict  boolean := false;
begin
  if p_winner is null or p_loser is null then
    raise exception 'both contacts are required' using errcode = 'null_value_not_allowed';
  end if;
  if p_winner = p_loser then
    raise exception 'a contact cannot be merged into itself' using errcode = 'check_violation';
  end if;

  -- ONE MERGE AT A TIME PER PAIR, and the key is ordered so two people pressing the button
  -- from opposite ends (A into B, B into A) queue instead of deadlocking. Same instrument and
  -- the same reasoning as crm_ensure_contact's lock: the alternative is two half-merges
  -- interleaving over the same nine tables.
  perform pg_advisory_xact_lock(
    hashtext('ss_crm_merge:' || p_client_id || ':' || least(p_winner, p_loser)::text));
  perform pg_advisory_xact_lock(
    hashtext('ss_crm_merge:' || p_client_id || ':' || greatest(p_winner, p_loser)::text));

  select * into v_win  from public.crm_contacts where id = p_winner and client_id = p_client_id;
  if not found then
    raise exception 'contact not found' using errcode = 'no_data_found';
  end if;
  select * into v_lose from public.crm_contacts where id = p_loser  and client_id = p_client_id;
  if not found then
    raise exception 'contact not found' using errcode = 'no_data_found';
  end if;

  -- REFUSE A TOMBSTONE AT EITHER END, loudly rather than by doing nothing.
  --   * merging INTO one would hang live rows off a record every read in the product filters
  --     out — the customer's history would simply stop appearing anywhere;
  --   * merging one AWAY again would rewrite where the first merge said it went, and
  --     merged_into is the only record of that.
  if v_win.merged_into is not null then
    raise exception 'that contact has already been merged into another one'
      using errcode = 'check_violation';
  end if;
  if v_lose.merged_into is not null then
    raise exception 'that contact has already been merged'
      using errcode = 'check_violation';
  end if;

  -- ⚠️ THE TOMBSTONE GOES FIRST, AND THE ORDER IS NOT COSMETIC. crm_contacts' two unique
  -- indexes are PARTIAL on `merged_into is null` (130:62-68). Enriching the winner with the
  -- loser's phone while the loser is still live collides with the loser's own row; with the
  -- tombstone set, that phone has left the index and the enrichment below is free.
  update public.crm_contacts
     set merged_into = p_winner, updated_at = now()
   where id = p_loser and client_id = p_client_id;

  -- ── RE-POINT ───────────────────────────────────────────────────────────────────────────
  -- Nine tables carry a contact_id. Every one of them is a thing somebody said, sent, filed
  -- or bought, and a merge that leaves any of them behind hangs it off a record nobody can
  -- open — which is worse than the duplicate it was meant to fix, because the duplicate at
  -- least still rendered.
  --
  -- The counts are returned so the caller can show what actually moved. A merge is
  -- irreversible in practice; "17 designs, 3 notes, 41 messages" is what makes it reviewable.
  update public.designs        set contact_id = p_winner where client_id = p_client_id and contact_id = p_loser;
  get diagnostics v_n = row_count; v_moved := v_moved || jsonb_build_object('designs', v_n);

  update public.captured_leads set contact_id = p_winner where client_id = p_client_id and contact_id = p_loser;
  get diagnostics v_n = row_count; v_moved := v_moved || jsonb_build_object('captured_leads', v_n);

  update public.crm_notes      set contact_id = p_winner where client_id = p_client_id and contact_id = p_loser;
  get diagnostics v_n = row_count; v_moved := v_moved || jsonb_build_object('notes', v_n);

  update public.crm_activities set contact_id = p_winner where client_id = p_client_id and contact_id = p_loser;
  get diagnostics v_n = row_count; v_moved := v_moved || jsonb_build_object('activities', v_n);

  update public.crm_files      set contact_id = p_winner where client_id = p_client_id and contact_id = p_loser;
  get diagnostics v_n = row_count; v_moved := v_moved || jsonb_build_object('files', v_n);

  update public.sms_messages   set contact_id = p_winner where client_id = p_client_id and contact_id = p_loser;
  get diagnostics v_n = row_count; v_moved := v_moved || jsonb_build_object('sms', v_n);

  update public.email_inbound  set contact_id = p_winner where client_id = p_client_id and contact_id = p_loser;
  get diagnostics v_n = row_count; v_moved := v_moved || jsonb_build_object('email_in', v_n);

  update public.email_sends    set contact_id = p_winner where client_id = p_client_id and contact_id = p_loser;
  get diagnostics v_n = row_count; v_moved := v_moved || jsonb_build_object('email_out', v_n);

  -- The two child tables 189 and 190 added. Not in the original list of nine because they did
  -- not exist when it was written, and leaving them out is not survivable: the loser's second
  -- email is the single thing a merge is most often performed to preserve.
  --
  -- FOLLOWERS: move the ones the winner does not already have, then drop the leftovers. A
  -- leftover is by definition the SAME person already following the SAME winning record, and
  -- the row carries nothing else worth keeping — only when they started following and why.
  -- Both records holding the same follower is common, and is often why somebody noticed the
  -- duplicate in the first place.
  update public.crm_contact_followers f set contact_id = p_winner
   where f.client_id = p_client_id and f.contact_id = p_loser
     and not exists (select 1 from public.crm_contact_followers f2
                      where f2.contact_id = p_winner and f2.user_id = f.user_id);
  get diagnostics v_n = row_count; v_moved := v_moved || jsonb_build_object('followers', v_n);
  delete from public.crm_contact_followers
   where client_id = p_client_id and contact_id = p_loser;   -- the duplicates left behind

  -- ⚠️ THE PEOPLE ROWS MOVE ONE AT A TIME, not as a set update, and the reason is the shape of
  -- 190's indexes. They are two SEPARATE partial uniques (phone per contact, email per
  -- contact), so a loser's row can collide with the winner on ONE channel while carrying a
  -- second channel the winner does not have — and a set-based "move the ones that do not
  -- collide, delete the rest" throws that second channel away. Which is the exact class of
  -- loss this whole change was written to stop, arriving through the merge instead of through
  -- the resolver.
  --
  -- So: try to move it; if it collides, fill the gaps on the row already there and drop the
  -- redundant copy; if THAT collides too (its two channels are split across two different
  -- rows on the winner), leave it attached to the tombstone rather than delete it. Nothing
  -- here ever destroys a channel — a stranded row is recoverable, a deleted one is not.
  v_n := 0; v_left := 0;
  for v_p in select * from public.crm_contact_people
              where client_id = p_client_id and contact_id = p_loser
              order by ordinal, created_at, id
  loop
    begin
      update public.crm_contact_people
         set contact_id = p_winner,
             ordinal = coalesce((select max(x.ordinal) from public.crm_contact_people x
                                  where x.contact_id = p_winner), 1) + 1,
             is_primary = false          -- the winner already has one, or none; never two
       where id = v_p.id;
      v_n := v_n + 1;
    exception when unique_violation then
      begin
        update public.crm_contact_people w set
          name  = coalesce(w.name,  v_p.name),
          phone = coalesce(w.phone, v_p.phone),
          email = coalesce(w.email, v_p.email)
         where w.contact_id = p_winner
           and ( (v_p.phone_digits is not null and w.phone_digits = v_p.phone_digits)
              or (v_p.email_lower  is not null and w.email_lower  = v_p.email_lower) );
        delete from public.crm_contact_people where id = v_p.id;
      exception when unique_violation then
        v_left := v_left + 1;
      end;
    end;
  end loop;
  v_moved := v_moved || jsonb_build_object('people', v_n)
                      || jsonb_build_object('people_stranded', v_left);

  -- THE LOSER'S OWN IDENTITY BECOMES A PERSON ON THE WINNER. Without this the merge does the
  -- thing it is supposed to prevent: the second name, the second number and the second email
  -- disappear behind the tombstone, and the record that survives can no longer be found by
  -- the channel half the customer's history arrived on.
  --
  -- ONLY THE CHANNELS THAT GENUINELY CONFLICT come here — the same test 191 applies, and for
  -- the same reason. A channel the winner is MISSING is picked up by the enrichment below and
  -- lands on the parent row where every reader in the product already looks; recording it
  -- here as well would store the customer's only phone number twice and leave a person row
  -- that is a copy of the record it hangs off.
  v_phone_conflict := coalesce(v_lose.phone_digits, '') <> ''
                      and coalesce(v_win.phone_digits, '') <> ''
                      and v_lose.phone_digits <> v_win.phone_digits;
  v_email_conflict := coalesce(v_lose.email_lower, '') <> ''
                      and coalesce(v_win.email_lower, '') <> ''
                      and v_lose.email_lower <> v_win.email_lower;
  v_name_conflict  := coalesce(btrim(coalesce(v_lose.name, '')), '') <> ''
                      and coalesce(btrim(coalesce(v_win.name, '')), '') <> ''
                      and lower(btrim(v_lose.name)) <> lower(btrim(v_win.name));

  if v_phone_conflict or v_email_conflict or v_name_conflict then
    begin
      insert into public.crm_contact_people
        (client_id, contact_id, ordinal, name, phone, email, source)
      values (p_client_id, p_winner,
              coalesce((select max(p.ordinal) from public.crm_contact_people p
                         where p.contact_id = p_winner), 1) + 1,
              nullif(btrim(coalesce(v_lose.name, '')), ''),
              case when v_phone_conflict then v_lose.phone else null end,
              case when v_email_conflict then v_lose.email else null end,
              'merge');
    exception when unique_violation then
      null;   -- already recorded on the winner; see 190 PART 2
    end;
  end if;

  -- ── ENRICH THE WINNER, NEVER BLANK IT ──────────────────────────────────────────────────
  -- The winner is the record the human chose to keep, so its stored values win every contest.
  -- The loser only fills gaps. This is 130's rule applied to a merge, and it is also the only
  -- shape that makes the operation safe to describe in one sentence to a builder: "nothing
  -- you can see on the record you kept will change".
  v_name   := coalesce(v_win.name,   nullif(btrim(coalesce(v_lose.name, '')), ''));
  v_phone  := coalesce(v_win.phone,  v_lose.phone);
  v_email  := coalesce(v_win.email,  v_lose.email);
  v_street := coalesce(v_win.street, v_lose.street);
  v_city   := coalesce(v_win.city,   v_lose.city);
  v_state  := coalesce(v_win.state,  v_lose.state);
  v_zip    := coalesce(v_win.zip,    v_lose.zip);
  v_bstreet := coalesce(v_win.billing_street, v_lose.billing_street);
  v_bcity   := coalesce(v_win.billing_city,   v_lose.billing_city);
  v_bstate  := coalesce(v_win.billing_state,  v_lose.billing_state);
  v_bzip    := coalesce(v_win.billing_zip,    v_lose.billing_zip);
  v_owner   := coalesce(v_win.owner_user_id,  v_lose.owner_user_id);

  update public.crm_contacts
     set name = v_name,
         phone = v_phone,
         phone_digits = public.crm_phone_key(v_phone),
         email = v_email,
         street = v_street, city = v_city, state = v_state, zip = v_zip,
         billing_street = v_bstreet, billing_city = v_bcity,
         billing_state = v_bstate, billing_zip = v_bzip,
         owner_user_id = v_owner,
         -- Labels are a set, so a union is the only answer that loses nothing. Nothing reads
         -- them yet (130 shipped the column with the owner); a merge that silently halved
         -- them the day something does would be very hard to notice.
         labels = (select coalesce(array_agg(distinct l), '{}'::text[])
                     from unnest(coalesce(v_win.labels, '{}'::text[])
                              || coalesce(v_lose.labels, '{}'::text[])) as l),
         -- The record is as old as the earlier of the two sightings. first_seen_at drives
         -- "how long have we known this person", and taking the winner's would make a
         -- long-standing customer look new.
         first_seen_at = least(v_win.first_seen_at, v_lose.first_seen_at),
         updated_at = now()
   where id = p_winner and client_id = p_client_id;

  -- ── THE CHANGELOG ──────────────────────────────────────────────────────────────────────
  -- One row naming what was folded in, plus a row per field the merge actually filled. Both
  -- go on the WINNER and both are written BEFORE the loser's history is re-pointed, so they
  -- cannot be swept along by the update below and end up duplicated or misdated.
  v_label := coalesce(nullif(btrim(coalesce(v_lose.name, '')), ''),
                      v_lose.phone, v_lose.email, p_loser::text);
  insert into public.crm_field_changes (client_id, contact_id, field, old_value, new_value, changed_by)
  values (p_client_id, p_winner, 'merged_from', v_label, p_loser::text, p_actor);

  if v_name  is distinct from v_win.name then
    insert into public.crm_field_changes (client_id, contact_id, field, old_value, new_value, changed_by)
    values (p_client_id, p_winner, 'name', v_win.name, v_name, p_actor);
  end if;
  if v_phone is distinct from v_win.phone then
    insert into public.crm_field_changes (client_id, contact_id, field, old_value, new_value, changed_by)
    values (p_client_id, p_winner, 'phone', v_win.phone, v_phone, p_actor);
  end if;
  if v_email is distinct from v_win.email then
    insert into public.crm_field_changes (client_id, contact_id, field, old_value, new_value, changed_by)
    values (p_client_id, p_winner, 'email', v_win.email, v_email, p_actor);
  end if;
  if v_owner is distinct from v_win.owner_user_id then
    insert into public.crm_field_changes (client_id, contact_id, field, old_value, new_value, changed_by)
    values (p_client_id, p_winner, 'owner', v_win.owner_user_id::text, v_owner::text, p_actor);
  end if;

  -- ⚠️ crm_field_changes IS RE-POINTED LAST, and it is the one table where the order is
  -- forced rather than chosen. Two reasons, and they point the same way:
  --   * its contact_id is NOT NULL and ON DELETE CASCADE (143). That cascade is exactly why
  --     this whole function sets merged_into instead of deleting the loser: a hard delete
  --     would take the loser's entire changelog with it — and crm_files' rows too, which
  --     carry the customer's own uploads — silently, as a side effect, with no row anywhere
  --     saying it happened. The tombstone is what keeps the audit trail alive, so it is not
  --     a nicety of 130's design, it is load-bearing here.
  --   * doing it before the inserts above would sweep this merge's own audit rows along with
  --     the history it is describing.
  update public.crm_field_changes set contact_id = p_winner
   where client_id = p_client_id and contact_id = p_loser;
  get diagnostics v_n = row_count; v_moved := v_moved || jsonb_build_object('field_changes', v_n);

  return jsonb_build_object(
    'ok', true, 'winner', p_winner, 'loser', p_loser,
    'label', v_label, 'moved', v_moved);
end
$fn$;

comment on function public.crm_merge_contacts(text, uuid, uuid, uuid) is
  'Fold one contact into another: sets crm_contacts.merged_into on the loser (never deletes it) and '
  're-points designs, captured_leads, crm_notes, crm_activities, crm_files, sms_messages, '
  'email_inbound, email_sends, crm_contact_people, crm_contact_followers and crm_field_changes onto '
  'the winner. The winner''s own values always survive; the loser only fills gaps. Migration 192.';

revoke execute on function public.crm_merge_contacts(text, uuid, uuid, uuid)
  from public, anon, authenticated;
grant  execute on function public.crm_merge_contacts(text, uuid, uuid, uuid) to service_role;

commit;

-- ─────────────────────────────────────────────────────────────────────────────────────────
-- VERIFY, on a scratch pair, inside a transaction you roll back:
--
--   begin;
--   select public.crm_merge_contacts('<tenant>', '<winner uuid>', '<loser uuid>');
--   -- the loser is a tombstone and nothing else:
--   select id, merged_into from public.crm_contacts where id in ('<winner>', '<loser>');
--   -- nothing still points at it anywhere:
--   select 'designs' t, count(*) from public.designs where contact_id = '<loser>'
--   union all select 'notes', count(*) from public.crm_notes where contact_id = '<loser>'
--   union all select 'people', count(*) from public.crm_contact_people where contact_id = '<loser>'
--   union all select 'changes', count(*) from public.crm_field_changes where contact_id = '<loser>';
--   rollback;
--
-- Then confirm the resolver agrees: crm_ensure_contact on the LOSER's phone must now return
-- the WINNER's id — the parent lookups all filter `merged_into is null`, and the loser's
-- number survives as a crm_contact_people row on the winner, which is the path 191 added.
