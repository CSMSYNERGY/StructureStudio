-- 189_crm_contact_followers.sql — who is watching this customer, and who owns them once a
-- quote goes out.
--
-- ── WHY (Carolyn, 2026-09-04 call, 1:09:30–1:10:46) ──────────────────────────────────────
-- "we do not ever assign deals. We only assign contacts and followers … if they are not
-- assigned to or following that customer, they can't see anything of it."
--
-- Two things in one sentence, and they are different objects. The ASSIGNEE is one person and
-- lives on crm_contacts.owner_user_id (writable since 188). FOLLOWERS are many, and had
-- nowhere to live at all. This is that table.
--
-- And on which of two reps ends up assigned when both have touched the same customer, she
-- declined to pick: "let's just put that in settings, and they can change it however they
-- want." So the rule is a per-tenant switch, not a constant — client_settings.
-- crm_assign_latest_quote below.
--
-- ⚠️ WHAT THIS FILE DOES NOT DO: it does not narrow anybody's reads. "they can't see
-- anything of it" describes where this is going; turning it on means a restrictive RLS
-- policy on crm_contacts keyed on owner/follower, which would take rows away from real
-- people on live the moment it applied — the class of change 154's header insists a human
-- reads first, and one this file is not entitled to smuggle in as a side effect of adding a
-- table. The data has to exist and be correct for a while before anything gates on it.
--
-- HAND-APPLY (inline, not --file: `supabase db query --file` auth-fails, retries and still
-- exits 0), then record in supabase_migrations.schema_migrations. Do NOT db push. BOM-free.
-- Inert on apply except for the settings column's default, which preserves today's behaviour.
--
-- Rollback:
--   drop function if exists public.crm_quote_assign(text, uuid, uuid);
--   drop table if exists public.crm_contact_followers;
--   alter table public.client_settings drop column if exists crm_assign_latest_quote;
--   (and remove the guarded block from save_design — regenerate from the LIVE body, never
--    from a repo file; see the splice section at the bottom.)

begin;

-- ─────────────────────────────────────────────────────────────────────────────────────────
-- PART 1 — the table.
-- ─────────────────────────────────────────────────────────────────────────────────────────
--
-- client_id is denormalized alongside contact_id, exactly as crm_notes, crm_activities and
-- crm_field_changes all do. It is what every policy and every index in this schema keys on;
-- deriving it through a join in an RLS policy would make the cheapest question in the system
-- (whose row is this?) the most expensive one.

create table if not exists public.crm_contact_followers (
  id          uuid primary key default gen_random_uuid(),
  client_id   text not null,
  contact_id  uuid not null references public.crm_contacts(id) on delete cascade,
  user_id     uuid not null,
  added_at    timestamptz not null default now(),
  -- HOW they came to be following. 'quote' is the automatic one below; the rest are for the
  -- people-picker and the merge. A vocabulary rather than free text because this is the
  -- column somebody will later want to filter on ("who did the system add?").
  added_reason text not null default 'manual'
                 check (added_reason in ('quote', 'manual', 'assigned', 'merge')),
  -- ONE ROW PER PERSON PER CONTACT. Following twice is not a thing, and without this the
  -- auto-follow below would append a row on every single re-save of the same design.
  constraint crm_contact_followers_uniq unique (contact_id, user_id)
);

-- The two questions actually asked: "who follows this contact" (the record page) and "which
-- contacts do I follow" (the list, and eventually the visibility rule).
create index if not exists crm_contact_followers_contact_idx
  on public.crm_contact_followers (client_id, contact_id);
create index if not exists crm_contact_followers_user_idx
  on public.crm_contact_followers (client_id, user_id, added_at desc);

comment on table public.crm_contact_followers is
  'Team members watching one contact (Carolyn 2026-09-04: "We only assign contacts and followers"). '
  'The single ASSIGNEE is crm_contacts.owner_user_id; this is the many. Service-role writes only.';

-- ── Posture: 130 / 131 / 143, plus the PUBLIC revoke ────────────────────────────────────
-- A new table ships world-readable in this project (112's whole point). Revoke, then grant
-- back exactly the read the portal needs.
--
-- ⚠️ `from public` AS WELL AS from the two roles, which 130/131/143 do not do. Revoking anon
-- and authenticated does not touch a grant held by PUBLIC, and PUBLIC is what every role
-- inherits — so a revoke that names only the roles can leave the table readable by the very
-- roles it just named. Harmless when there is no PUBLIC grant to remove, and the whole
-- difference when there is; the function revokes in this schema have always spelled it this
-- way.
alter table public.crm_contact_followers enable row level security;
revoke all on public.crm_contact_followers from public, anon, authenticated;
grant select on public.crm_contact_followers to authenticated;
drop policy if exists crm_contact_followers_owner_select on public.crm_contact_followers;
create policy crm_contact_followers_owner_select on public.crm_contact_followers
  for select to authenticated using (client_id = public.current_client_id());

-- NO `contacts`-AREA POLICY HERE, and that is 131's decision rather than an oversight. 154
-- proved SQL can express the area (area_level_for mirrors _shared/access.ts), but it added
-- those restrictive policies only to the five tables the BROWSER READS DIRECTLY over
-- PostgREST. Nothing reads this one directly — every follower read and write goes through
-- portal-settings, which already resolves the area — so a policy here would be a second copy
-- of the permission model guarding nothing, and _shared/access.ts is explicit that a
-- permission table which drifts is a permission table that lies. The day the record page
-- reads this table straight from the browser, add the policy in that commit.

-- ─────────────────────────────────────────────────────────────────────────────────────────
-- PART 2 — the setting.
-- ─────────────────────────────────────────────────────────────────────────────────────────
--
-- Carolyn declined to choose between the two reps: "let's just put that in settings, and they
-- can change it however they want."
--
-- FALSE (the default) = the FIRST quote assigns. Whoever brought the customer in keeps them,
-- and a later rep quoting the same person does not silently take the record — which is also
-- the only choice that changes nothing for the tenants who already have contacts.
-- TRUE = the LATEST quote assigns; the most recent rep to send something owns the customer.
--
-- client_settings is service-role only, so a tenant can neither read nor set this from the
-- browser; portal-settings' save action is where the switch has to be plumbed.

alter table public.client_settings
  add column if not exists crm_assign_latest_quote boolean not null default false;

comment on column public.client_settings.crm_assign_latest_quote is
  'Which rep ends up assigned when several quote the same person (Carolyn 2026-09-04, who asked '
  'for it to be a setting rather than a rule). false = the FIRST quote assigns and later quotes '
  'leave the owner alone; true = the LATEST quote reassigns. Default false, which is a no-op for '
  'every existing contact.';

-- ─────────────────────────────────────────────────────────────────────────────────────────
-- PART 3 — the thing save_design calls.
-- ─────────────────────────────────────────────────────────────────────────────────────────
--
-- ONE function rather than three statements spliced into save_design, for two reasons. It
-- keeps the splice into that function — the product's most critical write path — down to a
-- single line whose diff a human can check in a second (130's splice procedure exists
-- because that diff is the only review this gets). And the follow, the assignment and the
-- assignment's changelog row have to happen together or not at all: an owner that changes
-- with nothing in the changelog is exactly the complaint 188 was written to answer.
--
-- Everything here is a no-op when there is nothing to do, so the caller needs no conditions.

create or replace function public.crm_quote_assign(
  p_client_id  text,
  p_contact_id uuid,
  p_user_id    uuid
) returns void
language plpgsql
security definer
set search_path to ''
as $fn$
declare
  v_latest boolean;
  v_owner  uuid;
begin
  if p_client_id is null or p_contact_id is null or p_user_id is null then
    return;                          -- the anonymous designer has no user; nothing to record
  end if;

  -- MUST BE ON THIS TENANT'S TEAM. Two populations save designs through this path who are
  -- not: nobody (anon, handled above) and a CSM operator working in view-as, who has an
  -- auth.uid() but no client_users row on the tenant they are looking at. An operator is not
  -- a rep and following a builder's customer would put a CSM name in a builder's people
  -- list — and would eventually claim a share of a visibility rule written for their staff.
  -- The same lookup is what 188 does before storing an owner, for the same reason.
  if not exists (select 1 from public.client_users cu
                  where cu.user_id = p_user_id and cu.client_id = p_client_id) then
    return;
  end if;

  -- Following is idempotent by construction. A design is re-saved on every edit, so without
  -- ON CONFLICT this would be an insert per keystroke-batch rather than per relationship.
  insert into public.crm_contact_followers (client_id, contact_id, user_id, added_reason)
  values (p_client_id, p_contact_id, p_user_id, 'quote')
  on conflict (contact_id, user_id) do nothing;

  select coalesce(cs.crm_assign_latest_quote, false) into v_latest
    from public.client_settings cs where cs.client_id = p_client_id;
  v_latest := coalesce(v_latest, false);   -- a tenant with no settings row reads as FIRST-wins

  select c.owner_user_id into v_owner
    from public.crm_contacts c
   where c.id = p_contact_id and c.client_id = p_client_id;

  -- FIRST-wins leaves a set owner alone; LATEST-wins overwrites it. Both do nothing when the
  -- answer would not change, so the changelog does not fill with a row per re-save.
  if v_owner is not null and not v_latest then
    return;
  end if;
  if v_owner is not distinct from p_user_id then
    return;
  end if;

  update public.crm_contacts
     set owner_user_id = p_user_id, updated_at = now()
   where id = p_contact_id and client_id = p_client_id;

  -- The changelog row, in the same shape and under the same field name 188's editor writes,
  -- so the record page cannot tell a hand assignment from an automatic one apart from
  -- changed_by. Both are true things that happened to this contact.
  insert into public.crm_field_changes (client_id, contact_id, field, old_value, new_value, changed_by)
  values (p_client_id, p_contact_id, 'owner', v_owner::text, p_user_id::text, p_user_id);
end
$fn$;

-- Called by save_design (itself SECURITY DEFINER, so it runs as the owner) and by the service
-- role. Never by a browser: `contacts` is a real access area whose driver and crew-leader
-- presets resolve to none, and RLS cannot express that.
revoke execute on function public.crm_quote_assign(text, uuid, uuid)
  from public, anon, authenticated;
grant  execute on function public.crm_quote_assign(text, uuid, uuid) to service_role;

commit;

-- ═════════════════════════════════════════════════════════════════════════════════════════
-- 🚨 MANUAL STEP — SPLICE INTO save_design. DO NOT SKIP, DO NOT AUTOMATE FROM THE REPO.
-- ═════════════════════════════════════════════════════════════════════════════════════════
-- Same procedure and same warning as 130 and 133: save_design has been replaced wholesale
-- several times (031's version snapshot, 104's inventory-master protection, 111's invoiced
-- protection, 133's CRM link) and the repo's newest copy of it is EVIDENCE, not the source of
-- truth. Rebuilding it from any file — including 133 — can silently un-ship whatever landed
-- after that file was written.
--
--   1. select pg_get_functiondef('public.save_design'::regproc);
--   2. Paste that body into an editor.
--   3. Insert the block below IMMEDIATELY AFTER 133's existing `-- CRM CONTACT LINK` block,
--      so v_row.contact_id is already resolved.
--   4. Diff old vs new. The ONLY difference must be that block.
--   5. Apply, then submit one real design FROM THE PORTAL (signed in — the anon designer has
--      no auth.uid() and will correctly record nothing) on an internal tenant with beta mode
--      and a test inbox, and confirm a crm_contact_followers row appeared.
--
-- ⚠️ WHY THIS BLOCK DOES NOT LOOK LIKE 133'S, AND MUST NOT BE FOLDED INTO IT.
-- 133's block ends `exception when others then null;` and its header explains why: CRM
-- bookkeeping must never fail a customer's design save. That reasoning is still right and
-- nothing here weakens it. But the consequence is that ANY new failure added inside that
-- block is invisible by construction — no exception, no log, no row, and the only symptom is
-- an absence somebody would have to already suspect. 133 could live with that because its
-- own failure mode is self-healing: 130's backfill is re-runnable and picks up an unstamped
-- design later.
--
-- THIS ONE IS NOT SELF-HEALING. There is no backfill for "who was signed in when that quote
-- was sent", because auth.uid() only exists during the request. A follow that silently fails
-- is gone. So the block is SEPARATE and it RECORDS: the design still saves either way, but
-- app_errors gets a row saying it did not work, which is the difference between a bug that is
-- found and one that is not. Per migration 141 the severity is 'error' — this is a fault, not
-- the server refusing something.
--
-- The log call is itself wrapped, because a logger that can throw would defeat the guard it
-- is inside and hand the customer the failed save that all of this exists to prevent.
--
--   -- CONTACT ASSIGNMENT + AUTO-FOLLOW (migration 189). Carolyn 2026-09-04: "We only assign
--   -- contacts and followers." The rep who sends the quote follows the customer, and becomes
--   -- the assignee under the tenant's crm_assign_latest_quote rule.
--   --
--   -- SEPARATE FROM THE BLOCK ABOVE ON PURPOSE — see 189's header. That one swallows, which
--   -- is correct for something a re-runnable backfill repairs. Nothing can reconstruct who
--   -- was signed in, so this one records the failure instead of hiding it.
--   begin
--     perform public.crm_quote_assign(p_client_id, v_row.contact_id, auth.uid());
--   exception when others then
--     begin
--       perform public.log_error(
--         'save_design',
--         'crm_quote_assign failed: ' || coalesce(sqlerrm, '(no message)'),
--         'crm_quote_assign',
--         p_client_id,
--         null,
--         jsonb_build_object('code', p_code, 'sqlstate', sqlstate),
--         'error');
--     exception when others then
--       null;                      -- a logger that throws must never fail the design save
--     end;
--   end;
--
-- PROVE THE GUARD before trusting it, the way 133's was proven: inside a transaction, revoke
-- execute on crm_quote_assign from the definer's role, save a design from the portal, confirm
-- it STILL SAVES and that an app_errors row with code 'crm_quote_assign' appeared, then roll
-- back.
