-- ═════════════════════════════════════════════════════════════════════════════════════════
-- 385: NOTES, TASKS, EDIT HISTORY AND TEXTS ARE SERVER-ONLY. crm_notes, crm_activities,
--      crm_field_changes and sms_messages lose their browser read.
-- ═════════════════════════════════════════════════════════════════════════════════════════
--
-- ── NUMBERING ────────────────────────────────────────────────────────────────────────────
-- Read immediately before writing this (2026-11-11): the live ledger's highest numbered row is
-- 383, and origin/beta's folder ends at 383. A sibling session's unpushed branch holds
-- 384_phone_only_account, so this takes 385 and that session was told the same day. Re-read
-- the ledger (and `git ls-tree` every local branch) right before applying.
--
-- ── WHY ──────────────────────────────────────────────────────────────────────────────────
-- Each of the four tables was created with `grant select ... to authenticated` under one
-- permissive policy, client_id = current_client_id():
--   crm_notes, crm_activities   131_crm_notes_activities
--   crm_field_changes           143_crm_field_changes
--   sms_messages                150_crm_sms
-- 164 (sms_messages) and 194 (the other three) added a RESTRICTIVE policy,
-- current_area_level('contacts') <> 'none'. Nothing applies the 'own' level. So a rep whose
-- Contacts access is 'own' or 'own_view' (meant to see only the customers assigned to them or
-- followed by them) could open devtools, run
--     sb.from("crm_notes").select("*")       -- or crm_activities, crm_field_changes, sms_messages
-- and read every internal note, follow-up task, contact edit and text message in the company.
-- crm_contacts itself is already narrowed (crm_contacts_own_select), which is what makes this
-- a gap rather than a choice.
--
-- Confirmed on the live database 2026-11-11 with real JWT claims, in our own tenant (the only
-- one with non-owner users today), inside a transaction that rolled back: a user switched to
-- Contacts 'own' saw 35 of 153 contacts, but 116 of 116 notes, 4 of 4 activities, 138 of 138
-- field changes and 35 of 35 texts. Rows on that user's own contacts: 6, 2, 7 and 14.
-- The same gap migration 374 closed for email_inbound.
--
-- Nothing in the product reads these tables that way. Every reader is server-side and uses the
-- service role, and the server applies 'own' itself (visibleContactIds):
--   * portal-settings: the record page feed (_shared/crmFeed.ts), the inbox (crm_inbox), the
--     calls report, the notes and tasks writes and the edit history writer;
--   * the phone-api Worker: routes/reads.ts, routes/sms.ts, routes/media.ts, cron/usageCharge.ts;
--   * the SMS webhooks (sms-inbound, sms-status), _shared/smsSend.ts, crm-rules-tick, and the
--     lead, shop and unsubscribe functions.
-- The portal, the phone app and the extension never name these tables in a query. The phone app
-- and the extension hear about a new text from phone_realtime_notify's private broadcast (a
-- security definer trigger, ids only) and re-read through the Worker, not from postgres_changes.
-- None of the four is in a realtime publication, and no view reads them.
-- Every SQL function that reads or writes them is SECURITY DEFINER (crm_merge_contacts,
-- crm_create_contact, crm_update_contact, crm_import_leads, crm_rules_run, crm_rule_on_text,
-- phone_list_search, usage_charges_enqueue and the rest), so it runs as its owner.
-- The live counters agree: pg_stat_statements since 2026-04-28 holds 0 calls on these tables by
-- authenticated or anon, against about 4,400 by service_role, and every /rest/v1/<table>
-- request in the edge logs for the 24 hours before writing carried the secret key or a
-- service_role JWT.
--
-- Revoke, not a fifth policy: an own-scope policy would keep a read nobody uses, add a per-row
-- check, and need its own rule for texts with no contact. email_sends and (since 374)
-- email_inbound are already server-only; this makes every message and note table match.
-- Decided with Ahsan 2026-11-11.
--
-- ── WHAT ─────────────────────────────────────────────────────────────────────────────────
--   1. Revoke every privilege on the four tables from PUBLIC, anon and authenticated. Revoking
--      a table privilege also revokes the matching column privileges, so no column grant
--      survives.
--   2. Drop the eight SELECT policies (each table's _owner_select and _area_select). With no
--      grant they would decide nothing, and a policy that looks like access control but isn't
--      misleads the next reader of pg_policies.
--   3. Row level security stays ON with no policies: deny by default for every role that does
--      not bypass RLS. service_role bypasses it and keeps all of its privileges.
-- Untouched: every security definer function and trigger on the four tables (crm_stamp_author,
-- phone_realtime_notify, phone_push_text_notify, crm_rule_on_text, sms_messages_contact_made)
-- runs as its owner. No column, index, row or comment changes. No edge function or Worker
-- deploy goes with it. crm_contacts and its own-scope policy are not touched.
-- The assertions at the end abort the whole transaction if any API role can still touch a
-- table, if a policy is left, if RLS is off, or if service_role lost anything it needs.
--
-- ── APPLY ────────────────────────────────────────────────────────────────────────────────
-- By hand, like every migration here: the SQL editor or the Supabase connector. Not through
-- `supabase db query --linked`, which has run a begin/commit file as a silent no-op before.
-- A good run prints nothing, exactly like a no-op, so read the result back BEFORE recording it:
--   select t, has_table_privilege('authenticated', 'public.' || t, 'SELECT') as auth_sel,
--          has_table_privilege('anon', 'public.' || t, 'SELECT') as anon_sel,
--          (select count(*) from pg_policies p where p.schemaname = 'public' and p.tablename = t) as policies
--     from unnest(array['crm_notes', 'crm_activities', 'crm_field_changes', 'sms_messages']) t;
--   -- every row must be false, false, 0
-- Then record it under a plain number and check that a row came back:
--   insert into supabase_migrations.schema_migrations (version, name)
--     values ('385', '385_crm_reads_server_only') on conflict (version) do nothing
--     returning version, name;
-- The connector's apply_migration records its own row under a timestamp version. Renumber that
-- row to '385' instead of adding a second one (a timestamp sorts below '383' as text and hands
-- the next session a number that is already taken).
-- Proven offline by tests/sql/migration385.test.cjs.
--
-- ── ROLLBACK ─────────────────────────────────────────────────────────────────────────────
-- Put back exactly what 131, 143, 150, 164 and 194 made (this re-opens the gap described above):
--   grant select on public.crm_notes, public.crm_activities, public.crm_field_changes,
--                   public.sms_messages to authenticated;
--   create policy crm_notes_owner_select on public.crm_notes
--     for select to authenticated using (client_id = public.current_client_id());
--   create policy crm_activities_owner_select on public.crm_activities
--     for select to authenticated using (client_id = public.current_client_id());
--   create policy crm_field_changes_owner_select on public.crm_field_changes
--     for select to authenticated using (client_id = public.current_client_id());
--   create policy sms_messages_owner_select on public.sms_messages
--     for select to authenticated using (client_id = public.current_client_id());
--   create policy crm_notes_area_select on public.crm_notes as restrictive
--     for select to authenticated using (public.current_area_level('contacts') <> 'none');
--   create policy crm_activities_area_select on public.crm_activities as restrictive
--     for select to authenticated using (public.current_area_level('contacts') <> 'none');
--   create policy crm_field_changes_area_select on public.crm_field_changes as restrictive
--     for select to authenticated using (public.current_area_level('contacts') <> 'none');
--   create policy sms_messages_area_select on public.sms_messages as restrictive
--     for select to authenticated using (public.current_area_level('contacts') <> 'none');

begin;
set local lock_timeout = '5s';

revoke all on public.crm_notes         from public, anon, authenticated;
revoke all on public.crm_activities    from public, anon, authenticated;
revoke all on public.crm_field_changes from public, anon, authenticated;
revoke all on public.sms_messages      from public, anon, authenticated;

drop policy if exists crm_notes_owner_select         on public.crm_notes;
drop policy if exists crm_notes_area_select          on public.crm_notes;
drop policy if exists crm_activities_owner_select    on public.crm_activities;
drop policy if exists crm_activities_area_select     on public.crm_activities;
drop policy if exists crm_field_changes_owner_select on public.crm_field_changes;
drop policy if exists crm_field_changes_area_select  on public.crm_field_changes;
drop policy if exists sms_messages_owner_select      on public.sms_messages;
drop policy if exists sms_messages_area_select       on public.sms_messages;

alter table public.crm_notes         enable row level security;
alter table public.crm_activities    enable row level security;
alter table public.crm_field_changes enable row level security;
alter table public.sms_messages      enable row level security;

do $$
declare
  v_table text;
  v_rel   regclass;
  v_role  text;
  v_priv  text;
  v_left  text;
begin
  foreach v_table in array array['crm_notes', 'crm_activities', 'crm_field_changes', 'sms_messages'] loop
    v_rel := ('public.' || v_table)::regclass;

    -- No API role keeps any table privilege, directly or through PUBLIC.
    foreach v_role in array array['anon', 'authenticated'] loop
      foreach v_priv in array array['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER', 'MAINTAIN'] loop
        if has_table_privilege(v_role, v_rel, v_priv) then
          raise exception '385: % still has % on %', v_role, v_priv, v_rel;
        end if;
      end loop;
      foreach v_priv in array array['SELECT', 'INSERT', 'UPDATE', 'REFERENCES'] loop
        if has_any_column_privilege(v_role, v_rel, v_priv) then
          raise exception '385: % still has a column-level % on %', v_role, v_priv, v_rel;
        end if;
      end loop;
    end loop;

    if exists (
      select 1 from pg_class c, aclexplode(c.relacl) a
      where c.oid = v_rel and a.grantee = 0
    ) then
      raise exception '385: PUBLIC still holds a privilege on %', v_rel;
    end if;

    -- No policy left behind.
    select string_agg(policyname, ', ' order by policyname) into v_left
    from pg_policies where schemaname = 'public' and tablename = v_table;
    if v_left is not null then
      raise exception '385: policies still on %: %', v_rel, v_left;
    end if;

    -- Deny by default stays in force.
    if not (select relrowsecurity from pg_class where oid = v_rel) then
      raise exception '385: row level security is off on %', v_rel;
    end if;

    -- The feed, the webhooks, the Worker, the rules and the merge keep working.
    foreach v_priv in array array['SELECT', 'INSERT', 'UPDATE', 'DELETE'] loop
      if not has_table_privilege('service_role', v_rel, v_priv) then
        raise exception '385: service_role lost % on %', v_priv, v_rel;
      end if;
    end loop;
  end loop;
end $$;

commit;
