-- ═════════════════════════════════════════════════════════════════════════════════════════
-- 374: CUSTOMER REPLIES ARE SERVER-ONLY. email_inbound loses its browser read.
-- ═════════════════════════════════════════════════════════════════════════════════════════
--
-- ── NUMBERING ────────────────────────────────────────────────────────────────────────────
-- Read immediately before writing this (2026-11-07): the live ledger's highest numbered row is
-- 370, and origin/beta's folder ends at 370. Another session's unpushed Jack branches (jack-v1,
-- jack-v2) hold 370 to 373, and their 370 already clashes with beta's
-- 370_crm_rules_webhook_ghl_template, so that chain has to move anyway. This takes 374, and the
-- Jack session was told the same day that its chain starts at 375. Re-read the ledger (and
-- `git ls-tree` every local branch) right before applying.
--
-- ── WHY ──────────────────────────────────────────────────────────────────────────────────
-- 135 granted SELECT on email_inbound to `authenticated` under one permissive policy,
-- client_id = current_client_id(). 194 added a RESTRICTIVE policy, current_area_level('contacts')
-- <> 'none'. Nothing applies the 'own' level. So a rep whose Contacts access is 'own' (meant to
-- see only the customers assigned to them) could open devtools, run
--     sb.from("email_inbound").select("*")
-- and read every customer reply the company has received: who wrote, the subject, and the full
-- body as text and HTML. Confirmed on the live database 2026-11-07 (pg_policies and
-- has_table_privilege('authenticated', 'public.email_inbound', 'SELECT') = true).
--
-- Nothing in the product reads the table that way. Every reader is server-side and uses the
-- service role:
--   * portal-settings: the record page feed (_shared/crmFeed.ts) and the inbox list;
--   * the phone-api Worker: routes/reads.ts (threads, list, bodies) and routes/push.ts;
--   * the email-inbound webhook, which writes the rows.
-- The live edge logs agree: every /rest/v1/email_inbound request on 2026-11-01 and from
-- 2026-11-04 to 2026-11-07 carried the secret key or a service_role JWT, none a user's token.
-- The table is in no realtime publication. The phone app and the extension hear about a new
-- reply from phone_realtime_notify's broadcast (a security definer trigger), not from
-- postgres_changes, so they are unaffected.
--
-- email_sends, the outbound twin holding the same kind of words, has been service-role only from
-- the start. This makes the pair match.
--
-- ── WHAT ─────────────────────────────────────────────────────────────────────────────────
--   1. Revoke every privilege on the table from PUBLIC, anon and authenticated. Revoking a table
--      privilege also revokes the matching column privileges, so no column grant survives.
--   2. Drop 135's and 194's two SELECT policies. With no grant they would decide nothing, and a
--      policy that looks like access control but isn't misleads the next reader of pg_policies.
--   3. Row level security stays ON with no policies: deny by default for every role that does
--      not bypass RLS. service_role bypasses it and keeps all of its privileges.
-- Untouched: the three security definer functions that read or write the table
-- (crm_merge_contacts, phone_realtime_notify, phone_push_email_notify) run as their owner; the
-- three triggers (crm_rule_on_email_in, email_inbound_phone_realtime, phone_push_email) fire in
-- the service-role insert that started them. No column, index, row or comment changes.
-- The assertions at the end abort the whole transaction if any API role can still touch the
-- table, if a policy is left, if RLS is off, or if service_role lost anything it needs.
--
-- ── APPLY ────────────────────────────────────────────────────────────────────────────────
-- By hand, like every migration here: the SQL editor or the Supabase connector. Not through
-- `supabase db query --linked`, which has run a begin/commit file as a silent no-op before.
-- A good run prints nothing, exactly like a no-op, so read the result back BEFORE recording it:
--   select has_table_privilege('authenticated', 'public.email_inbound', 'SELECT') as auth_sel,
--          has_table_privilege('anon', 'public.email_inbound', 'SELECT') as anon_sel,
--          (select count(*) from pg_policies
--            where schemaname = 'public' and tablename = 'email_inbound') as policies;
--   -- must be false, false, 0
-- Then record it under a plain number and check that a row came back:
--   insert into supabase_migrations.schema_migrations (version, name)
--     values ('374', '374_email_inbound_server_only') on conflict (version) do nothing
--     returning version, name;
-- The connector's apply_migration records its own row under a timestamp version. Renumber that
-- row to '374' instead of adding a second one (a timestamp sorts below '370' as text and hands
-- the next session a number that is already taken).
-- No edge function or Worker deploy goes with it. Proven offline by
-- tests/sql/migration374.test.cjs.
--
-- ── ROLLBACK ─────────────────────────────────────────────────────────────────────────────
-- Put back exactly what 135 and 194 made (this re-opens the gap described above):
--   grant select on public.email_inbound to authenticated;
--   create policy email_inbound_owner_select on public.email_inbound
--     for select to authenticated using (client_id = public.current_client_id());
--   create policy email_inbound_area_select on public.email_inbound
--     as restrictive for select to authenticated
--     using (public.current_area_level('contacts') <> 'none');

begin;
set local lock_timeout = '5s';

revoke all on public.email_inbound from public, anon, authenticated;

drop policy if exists email_inbound_owner_select on public.email_inbound;
drop policy if exists email_inbound_area_select on public.email_inbound;

alter table public.email_inbound enable row level security;

do $$
declare
  v_role text;
  v_priv text;
  v_left text;
begin
  -- No API role keeps any table privilege, directly or through PUBLIC.
  foreach v_role in array array['anon', 'authenticated'] loop
    foreach v_priv in array array['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER', 'MAINTAIN'] loop
      if has_table_privilege(v_role, 'public.email_inbound', v_priv) then
        raise exception '374: % still has % on public.email_inbound', v_role, v_priv;
      end if;
    end loop;
    foreach v_priv in array array['SELECT', 'INSERT', 'UPDATE', 'REFERENCES'] loop
      if has_any_column_privilege(v_role, 'public.email_inbound', v_priv) then
        raise exception '374: % still has a column-level % on public.email_inbound', v_role, v_priv;
      end if;
    end loop;
  end loop;

  if exists (
    select 1 from pg_class c, aclexplode(c.relacl) a
    where c.oid = 'public.email_inbound'::regclass and a.grantee = 0
  ) then
    raise exception '374: PUBLIC still holds a privilege on public.email_inbound';
  end if;

  -- No policy left behind.
  select string_agg(policyname, ', ') into v_left
  from pg_policies where schemaname = 'public' and tablename = 'email_inbound';
  if v_left is not null then
    raise exception '374: policies still on public.email_inbound: %', v_left;
  end if;

  -- Deny by default stays in force.
  if not (select relrowsecurity from pg_class where oid = 'public.email_inbound'::regclass) then
    raise exception '374: row level security is off on public.email_inbound';
  end if;

  -- The webhook, the feed, the Worker and the merge keep working.
  foreach v_priv in array array['SELECT', 'INSERT', 'UPDATE', 'DELETE'] loop
    if not has_table_privilege('service_role', 'public.email_inbound', v_priv) then
      raise exception '374: service_role lost % on public.email_inbound', v_priv;
    end if;
  end loop;
end $$;

commit;
