-- 301_crm_pipelines.sql — hand-moved sales pipelines in the built-in CRM.
--
-- ⛔ APPLY BY HAND, AFTER A HUMAN HAS READ IT. Pipe this file to `supabase db query --linked`
--    (stdin; see 270's header), then record it:
--      insert into supabase_migrations.schema_migrations (version, name) values ('301', '301_crm_pipelines') returning version;
--    NEVER `supabase db push`. The file carries its own begin;/commit;, so a failed check anywhere
--    takes the whole migration with it. To rehearse and change nothing, swap the last `commit;`
--    for `rollback;`.
--
-- ── WHY ──────────────────────────────────────────────────────────────────────────────────
-- Carolyn, 2026-10-09: sales reps are about to cold-call shed manufacturers, and she wants those
-- prospects worked in a pipeline INSIDE Structure Studio, each one landing in its contacts. The
-- existing board (portal/02-sales.jsx, the Pipeline tab) cannot hold them: its columns are
-- DERIVED from designs.status and a prospect has no design. Its own comment named this file:
-- "Moving a deal by hand needs the local crm_stages table, which is the next increment".
-- Decided with her the same day: a general CRM feature for every CRM builder (not internal-only),
-- reps see only their own leads, leads come from CSV import + manual add + the website's Book a
-- Demo, and calls go through the existing My Synergy Phone.
--
-- ── WHAT THIS DOES ───────────────────────────────────────────────────────────────────────
--   PART 1  crm_contacts.company — the business a contact works for. For a manufacturer prospect
--           the CONTACT stays the person you call; the company is what the card is headed with.
--   PART 2  crm_pipelines / crm_pipeline_stages / crm_deals / crm_deal_stage_changes.
--   PART 3  crm_seed_pipeline(client, kind) — the starter pipelines, idempotent per tenant.
--   PART 4  crm_move_deal(...) — a stage change and its history row in one statement.
--   PART 5  crm_create_lead(...) — a contact (or the existing one it matches) plus a deal.
--   PART 6  CSM Synergy's own account gets "Manufacturer Outreach".
--   PART 7  checks.
--
-- ── THE RULES ────────────────────────────────────────────────────────────────────────────
--   * A DEAL HAS NO OWNER OF ITS OWN. Carolyn 2026-09-04 @1:09:30: "we do not ever assign deals.
--     We only assign contacts and followers." A deal is visible to exactly the people its
--     CONTACT is visible to (crm_contact_visible_to, 193/286), so "reps see only their own"
--     falls out of the scope that already exists, and reassigning the contact moves its deals.
--   * NO BROWSER ACCESS AT ALL, the pm_* posture (144): RLS on, zero policies, revoked from anon
--     and authenticated. Every read and write goes through portal-settings, which applies the
--     contact scope by hand (the service role is BYPASSRLS — see its CONTACT SCOPE notes). A
--     restrictive SELECT policy here would be a second transcription of the scope, read by
--     nothing.
--   * AUTOMATION KEYS ON STAGE `kind` (open|won|lost), NEVER THE NAME. Names are tenant-editable
--     (the Build Schedule's rule 1, and the Monday label-rename lesson).
--   * TENANT CONSISTENCY IS A FOREIGN KEY, not a hope: stages and deals reference their pipeline
--     and stage by (id, client_id), so a deal can never sit in another tenant's stage whatever a
--     caller sends.
--   * A MERGED CONTACT'S DEALS are not moved by crm_merge_contacts (192/254), which this file does
--     not re-issue. portal-settings' deal reads follow merged_into and re-point the deal, the same
--     self-heal a tombstone gets everywhere else it is read. Re-issue the merge when it next
--     changes for another reason.

begin;

-- ── PART 1 ───────────────────────────────────────────────────────────────────────────────
alter table public.crm_contacts add column if not exists company text;
comment on column public.crm_contacts.company is
  'The business this contact works for (301). Optional; a homeowner buying a shed has none. Shown as the card heading on a sales pipeline.';

-- 'booking' — the website''s Book a Demo (slice 4, crm-inbound-lead). Added now so the check is
-- issued once. Every earlier value is kept (282 is the current definition).
alter table public.crm_contacts drop constraint if exists crm_contacts_source_check;
alter table public.crm_contacts add constraint crm_contacts_source_check
  check (source in ('design', 'captured_lead', 'manual', 'import', 'phone', 'ghl_import', 'booking'));

-- ── PART 2 ───────────────────────────────────────────────────────────────────────────────
create table if not exists public.crm_pipelines (
  id           uuid primary key default gen_random_uuid(),
  client_id    text not null,
  name         text not null check (length(btrim(name)) between 1 and 80),
  position     double precision not null default 1024,
  -- The pick list a Lost move chooses from. Tenant-edited in Settings → CRM → Pipelines.
  lost_reasons text[] not null default '{}',
  -- 'sales' | 'outreach' — which starter this was seeded as; NULL for one a person made.
  seed_kind    text,
  archived_at  timestamptz,
  created_by   uuid,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  unique (id, client_id)
);
create index if not exists crm_pipelines_client_idx on public.crm_pipelines (client_id, position) where archived_at is null;
create unique index if not exists crm_pipelines_seed_once on public.crm_pipelines (client_id, seed_kind) where seed_kind is not null;

create table if not exists public.crm_pipeline_stages (
  id          uuid primary key default gen_random_uuid(),
  client_id   text not null,
  pipeline_id uuid not null,
  name        text not null check (length(btrim(name)) between 1 and 60),
  color       text not null default '#64748B' check (color ~ '^#[0-9A-Fa-f]{6}$'),
  kind        text not null default 'open' check (kind in ('open', 'won', 'lost')),
  position    double precision not null default 1024,
  archived_at timestamptz,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  unique (id, client_id),
  unique (id, pipeline_id),
  foreign key (pipeline_id, client_id) references public.crm_pipelines (id, client_id) on delete cascade
);
create index if not exists crm_pipeline_stages_pipeline_idx on public.crm_pipeline_stages (pipeline_id, position) where archived_at is null;

create table if not exists public.crm_deals (
  id                 uuid primary key default gen_random_uuid(),
  client_id          text not null,
  pipeline_id        uuid not null,
  stage_id           uuid not null,
  contact_id         uuid not null references public.crm_contacts (id) on delete cascade,
  title              text check (title is null or length(title) <= 200),
  value_cents        bigint check (value_cents is null or value_cents >= 0),
  expected_close_date date,
  next_follow_up_at  timestamptz,
  lost_reason        text check (lost_reason is null or length(lost_reason) <= 200),
  source             text not null default 'manual' check (source in ('manual', 'import', 'booking', 'phone')),
  stage_entered_at   timestamptz not null default now(),
  won_at             timestamptz,
  lost_at            timestamptz,
  created_by         uuid,
  archived_at        timestamptz,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  foreign key (pipeline_id, client_id) references public.crm_pipelines (id, client_id) on delete cascade,
  -- The stage must belong to the deal's pipeline AND tenant: both pairs are enforced.
  foreign key (stage_id, client_id) references public.crm_pipeline_stages (id, client_id),
  foreign key (stage_id, pipeline_id) references public.crm_pipeline_stages (id, pipeline_id)
);
create index if not exists crm_deals_board_idx on public.crm_deals (client_id, pipeline_id, stage_id) where archived_at is null;
create index if not exists crm_deals_contact_idx on public.crm_deals (contact_id);
create index if not exists crm_deals_follow_up_idx on public.crm_deals (client_id, next_follow_up_at) where archived_at is null and next_follow_up_at is not null;

create table if not exists public.crm_deal_stage_changes (
  id         bigserial primary key,
  client_id  text not null,
  deal_id    uuid not null references public.crm_deals (id) on delete cascade,
  from_stage uuid,
  to_stage   uuid not null,
  changed_by uuid,
  changed_at timestamptz not null default now()
);
create index if not exists crm_deal_stage_changes_deal_idx on public.crm_deal_stage_changes (deal_id, changed_at);

alter table public.crm_pipelines          enable row level security;
alter table public.crm_pipeline_stages    enable row level security;
alter table public.crm_deals              enable row level security;
alter table public.crm_deal_stage_changes enable row level security;
revoke all on public.crm_pipelines, public.crm_pipeline_stages, public.crm_deals, public.crm_deal_stage_changes
  from public, anon, authenticated;
revoke all on sequence public.crm_deal_stage_changes_id_seq from public, anon, authenticated;

-- ── PART 3 — starter pipelines ───────────────────────────────────────────────────────────
-- Idempotent per (tenant, kind) through crm_pipelines_seed_once: a second call, or two first
-- opens at once, returns the one row. portal-settings calls it for 'sales' the first time a CRM
-- tenant with no pipeline opens the board, so no tenant needs a backfill here.
create or replace function public.crm_seed_pipeline(p_client_id text, p_kind text default 'sales')
returns uuid
language plpgsql
security definer
set search_path to ''
as $fn$
declare
  v_id     uuid;
  v_name   text;
  v_stages jsonb;
  v_lost   text[];
  v_s      jsonb;
  v_i      integer := 0;
begin
  if coalesce(btrim(p_client_id), '') = '' then
    raise exception 'a tenant is required' using errcode = 'null_value_not_allowed';
  end if;
  if p_kind = 'sales' then
    v_name := 'Sales';
    v_stages := '[{"n":"New Lead","c":"#64748B","k":"open"},{"n":"Contacted","c":"#0EA5E9","k":"open"},
                  {"n":"Qualified","c":"#6366F1","k":"open"},{"n":"Proposal Sent","c":"#F59E0B","k":"open"},
                  {"n":"Won","c":"#16A34A","k":"won"},{"n":"Lost","c":"#DC2626","k":"lost"}]';
    v_lost := array['Price', 'Went with a competitor', 'Timing', 'No response', 'Not a fit'];
  elsif p_kind = 'outreach' then
    v_name := 'Manufacturer Outreach';
    v_stages := '[{"n":"New Lead","c":"#64748B","k":"open"},{"n":"Attempting Contact","c":"#0EA5E9","k":"open"},
                  {"n":"Connected","c":"#14B8A6","k":"open"},{"n":"Demo Scheduled","c":"#6366F1","k":"open"},
                  {"n":"Demo Completed","c":"#8B5CF6","k":"open"},{"n":"Proposal Sent","c":"#F59E0B","k":"open"},
                  {"n":"Not Now / Nurture","c":"#94A3B8","k":"open"},
                  {"n":"Won","c":"#16A34A","k":"won"},{"n":"Lost","c":"#DC2626","k":"lost"}]';
    v_lost := array['Not interested', 'Happy with current software', 'Price', 'Too small', 'Wrong contact / bad number', 'Went with a competitor'];
  else
    raise exception 'unknown starter pipeline %', p_kind using errcode = 'invalid_parameter_value';
  end if;

  insert into public.crm_pipelines (client_id, name, lost_reasons, seed_kind,
         position)
  values (p_client_id, v_name, v_lost, p_kind,
          coalesce((select max(position) from public.crm_pipelines where client_id = p_client_id), 0) + 1024)
  on conflict (client_id, seed_kind) where seed_kind is not null do nothing
  returning id into v_id;

  if v_id is null then
    select id into v_id from public.crm_pipelines where client_id = p_client_id and seed_kind = p_kind;
    return v_id;
  end if;

  for v_s in select * from jsonb_array_elements(v_stages) loop
    v_i := v_i + 1;
    insert into public.crm_pipeline_stages (client_id, pipeline_id, name, color, kind, position)
    values (p_client_id, v_id, v_s->>'n', v_s->>'c', v_s->>'k', v_i * 1024);
  end loop;
  return v_id;
end;
$fn$;
revoke execute on function public.crm_seed_pipeline(text, text) from public, anon, authenticated;
grant  execute on function public.crm_seed_pipeline(text, text) to service_role;

-- ── PART 4 — move a deal ─────────────────────────────────────────────────────────────────
-- The stage may be in ANOTHER pipeline of the same tenant: the deal moves with it. Won/lost
-- timestamps follow the stage KIND. A Lost move requires a reason (Carolyn's plan: "mark Lost
-- (reason required)"); leaving a lost stage clears it. A move to the stage it is already in is
-- a no-op that writes no history row. Returns the deal's new stage_entered_at.
create or replace function public.crm_move_deal(
  p_client_id   text,
  p_deal        uuid,
  p_stage       uuid,
  p_actor       uuid default null,
  p_lost_reason text default null
) returns jsonb
language plpgsql
security definer
set search_path to ''
as $fn$
declare
  v_deal  public.crm_deals%rowtype;
  v_stage public.crm_pipeline_stages%rowtype;
  v_now   timestamptz := now();
  v_reason text := nullif(btrim(coalesce(p_lost_reason, '')), '');
begin
  select * into v_deal from public.crm_deals
   where id = p_deal and client_id = p_client_id and archived_at is null
   for update;
  if not found then
    raise exception 'deal not found' using errcode = 'no_data_found';
  end if;
  select * into v_stage from public.crm_pipeline_stages
   where id = p_stage and client_id = p_client_id and archived_at is null;
  if not found then
    raise exception 'stage not found' using errcode = 'no_data_found';
  end if;
  if v_deal.stage_id = v_stage.id then
    return jsonb_build_object('moved', false, 'stage_entered_at', v_deal.stage_entered_at);
  end if;
  if v_stage.kind = 'lost' and v_reason is null then
    raise exception 'a lost reason is required' using errcode = 'check_violation';
  end if;

  update public.crm_deals set
    pipeline_id      = v_stage.pipeline_id,
    stage_id         = v_stage.id,
    stage_entered_at = v_now,
    won_at           = case when v_stage.kind = 'won'  then coalesce(won_at, v_now)  else null end,
    lost_at          = case when v_stage.kind = 'lost' then coalesce(lost_at, v_now) else null end,
    lost_reason      = case when v_stage.kind = 'lost' then left(v_reason, 200) else null end,
    updated_at       = v_now
  where id = v_deal.id;

  insert into public.crm_deal_stage_changes (client_id, deal_id, from_stage, to_stage, changed_by, changed_at)
  values (p_client_id, v_deal.id, v_deal.stage_id, v_stage.id, p_actor, v_now);

  return jsonb_build_object('moved', true, 'stage_entered_at', v_now, 'kind', v_stage.kind);
end;
$fn$;
revoke execute on function public.crm_move_deal(text, uuid, uuid, uuid, text) from public, anon, authenticated;
grant  execute on function public.crm_move_deal(text, uuid, uuid, uuid, text) to service_role;

-- ── PART 5 — a new lead: contact + deal ──────────────────────────────────────────────────
-- Used by "+ Add lead" (source manual), the CSV import (import) and Book a Demo (booking).
--
-- MATCHING: a phone, then an email, that a live contact on this tenant already holds is THAT
-- contact — the same two keys crm_contacts' unique indexes enforce. Behaviour then depends on
-- p_on_match:
--   'refuse'  → nothing is written; returns {existing: id}. "+ Add lead" uses this so a person
--               is told "that's already a contact — open it" instead of silently getting a
--               second deal on someone else's customer.
--   'attach'  → the deal goes on the existing contact; blanks on it are filled (company, name,
--               email/phone), nothing is overwritten, the owner is never changed. The import
--               and Book a Demo use this, so a re-run or a second booking never duplicates.
-- p_stage NULL → contact only, no deal.
--
-- OWNER on a NEW contact is p_owner, checked against the tenant's team in this statement (the
-- crm_create_contact rule). It is logged in crm_field_changes the way an owner change is.
create or replace function public.crm_create_lead(
  p_client_id   text,
  p_name        text,
  p_company     text,
  p_phone       text,
  p_email       text,
  p_owner       uuid,
  p_actor       uuid,
  p_source      text,
  p_stage       uuid,
  p_title       text default null,
  p_value_cents bigint default null,
  p_on_match    text default 'refuse'
) returns jsonb
language plpgsql
security definer
set search_path to ''
as $fn$
declare
  v_name    text := left(nullif(btrim(coalesce(p_name, '')), ''), 200);
  v_company text := left(nullif(btrim(coalesce(p_company, '')), ''), 200);
  v_phone   text := left(nullif(btrim(coalesce(p_phone, '')), ''), 40);
  v_email   text := left(nullif(btrim(coalesce(p_email, '')), ''), 320);
  v_digits  text;
  v_cid     uuid;
  v_matched boolean := false;
  v_stage   public.crm_pipeline_stages%rowtype;
  v_deal    uuid;
  v_src     text := coalesce(nullif(btrim(p_source), ''), 'manual');
begin
  if coalesce(btrim(p_client_id), '') = '' then
    raise exception 'a tenant is required' using errcode = 'null_value_not_allowed';
  end if;
  if v_src not in ('manual', 'import', 'booking', 'phone') then
    raise exception 'unknown lead source %', v_src using errcode = 'invalid_parameter_value';
  end if;
  v_digits := public.crm_phone_key(v_phone);
  if v_digits is null and v_email is null then
    raise exception 'a phone number or an email is required' using errcode = 'check_violation';
  end if;
  if v_name is null and v_company is null then
    raise exception 'a name or a company is required' using errcode = 'check_violation';
  end if;
  if p_owner is not null
     and not exists (select 1 from public.client_users cu where cu.user_id = p_owner and cu.client_id = p_client_id) then
    raise exception 'owner is not on this team' using errcode = 'foreign_key_violation';
  end if;
  if p_stage is not null then
    select * into v_stage from public.crm_pipeline_stages
     where id = p_stage and client_id = p_client_id and archived_at is null;
    if not found then
      raise exception 'stage not found' using errcode = 'no_data_found';
    end if;
    if v_stage.kind = 'lost' then
      raise exception 'a deal cannot start lost' using errcode = 'check_violation';
    end if;
  end if;

  -- Match: phone first, then email (on a contact with or without a phone).
  if v_digits is not null then
    select id into v_cid from public.crm_contacts
     where client_id = p_client_id and phone_digits = v_digits and merged_into is null
     limit 1;
  end if;
  if v_cid is null and v_email is not null then
    select id into v_cid from public.crm_contacts
     where client_id = p_client_id and email_lower = lower(v_email) and merged_into is null
     order by (phone_digits is null) desc, created_at
     limit 1;
  end if;
  v_matched := v_cid is not null;

  if v_matched and coalesce(p_on_match, 'refuse') = 'refuse' then
    return jsonb_build_object('existing', v_cid);
  end if;

  if v_matched then
    -- Fill blanks only. The email is written only when no other live contact holds it, so a
    -- phone contact never takes an address that is somebody else's key (282's S2822 rule).
    update public.crm_contacts c set
      name    = coalesce(nullif(btrim(c.name), ''), v_name),
      company = coalesce(nullif(btrim(c.company), ''), v_company),
      phone   = case when c.phone_digits is null and v_digits is not null
                      and not exists (select 1 from public.crm_contacts o where o.client_id = p_client_id
                                       and o.phone_digits = v_digits and o.merged_into is null)
                     then v_phone else c.phone end,
      phone_digits = case when c.phone_digits is null and v_digits is not null
                      and not exists (select 1 from public.crm_contacts o where o.client_id = p_client_id
                                       and o.phone_digits = v_digits and o.merged_into is null)
                     then v_digits else c.phone_digits end,
      email   = case when nullif(btrim(c.email), '') is null and v_email is not null
                      and not exists (select 1 from public.crm_contacts o where o.client_id = p_client_id
                                       and o.email_lower = lower(v_email) and o.merged_into is null and o.id <> c.id)
                     then v_email else c.email end,
      updated_at = now()
    where c.id = v_cid;
  else
    insert into public.crm_contacts (client_id, name, company, phone, phone_digits, email, owner_user_id, source)
    values (p_client_id, v_name, v_company, v_phone, v_digits, v_email, p_owner, v_src)
    returning id into v_cid;
    if p_owner is not null then
      insert into public.crm_field_changes (client_id, contact_id, field, old_value, new_value, changed_by)
      values (p_client_id, v_cid, 'owner', null, p_owner::text, p_actor);
    end if;
  end if;

  if p_stage is not null then
    insert into public.crm_deals (client_id, pipeline_id, stage_id, contact_id, title, value_cents,
                                  source, created_by, won_at, lost_at)
    values (p_client_id, v_stage.pipeline_id, v_stage.id, v_cid,
            left(nullif(btrim(coalesce(p_title, '')), ''), 200),
            case when p_value_cents is not null and p_value_cents >= 0 then p_value_cents end,
            v_src, p_actor,
            case when v_stage.kind = 'won' then now() end,
            null)
    returning id into v_deal;
    insert into public.crm_deal_stage_changes (client_id, deal_id, from_stage, to_stage, changed_by)
    values (p_client_id, v_deal, null, v_stage.id, p_actor);
  end if;

  return jsonb_build_object('contactId', v_cid, 'dealId', v_deal, 'matched', v_matched);
end;
$fn$;
comment on function public.crm_create_lead(text, text, text, text, text, uuid, uuid, text, uuid, text, bigint, text) is
  'Sales pipelines (301): a contact — new, or the live one its phone then email already matches — plus an optional deal in p_stage, with the deal''s first stage-history row. p_on_match refuse returns {existing} and writes nothing; attach fills blanks on the match and never changes its owner. A lost stage cannot be a starting stage. service_role only.';
revoke execute on function public.crm_create_lead(text, text, text, text, text, uuid, uuid, text, uuid, text, bigint, text) from public, anon, authenticated;
grant  execute on function public.crm_create_lead(text, text, text, text, text, uuid, uuid, text, uuid, text, bigint, text) to service_role;

-- A deal on a contact that already exists (the record page's "+ Add to pipeline"). The deal and
-- its first history row land together. A lost stage cannot be a starting stage.
create or replace function public.crm_add_deal(
  p_client_id   text,
  p_contact     uuid,
  p_stage       uuid,
  p_actor       uuid default null,
  p_title       text default null,
  p_value_cents bigint default null,
  p_source      text default 'manual'
) returns uuid
language plpgsql
security definer
set search_path to ''
as $fn$
declare
  v_stage public.crm_pipeline_stages%rowtype;
  v_deal  uuid;
begin
  if not exists (select 1 from public.crm_contacts where id = p_contact and client_id = p_client_id and merged_into is null) then
    raise exception 'contact not found' using errcode = 'no_data_found';
  end if;
  select * into v_stage from public.crm_pipeline_stages
   where id = p_stage and client_id = p_client_id and archived_at is null;
  if not found then
    raise exception 'stage not found' using errcode = 'no_data_found';
  end if;
  if v_stage.kind = 'lost' then
    raise exception 'a deal cannot start lost' using errcode = 'check_violation';
  end if;
  insert into public.crm_deals (client_id, pipeline_id, stage_id, contact_id, title, value_cents, source, created_by, won_at)
  values (p_client_id, v_stage.pipeline_id, v_stage.id, p_contact,
          left(nullif(btrim(coalesce(p_title, '')), ''), 200),
          case when p_value_cents is not null and p_value_cents >= 0 then p_value_cents end,
          coalesce(nullif(btrim(p_source), ''), 'manual'), p_actor,
          case when v_stage.kind = 'won' then now() end)
  returning id into v_deal;
  insert into public.crm_deal_stage_changes (client_id, deal_id, from_stage, to_stage, changed_by)
  values (p_client_id, v_deal, null, v_stage.id, p_actor);
  return v_deal;
end;
$fn$;
revoke execute on function public.crm_add_deal(text, uuid, uuid, uuid, text, bigint, text) from public, anon, authenticated;
grant  execute on function public.crm_add_deal(text, uuid, uuid, uuid, text, bigint, text) to service_role;

-- ── PART 6 — our own account ─────────────────────────────────────────────────────────────
-- Keyed on the flag, never the slug (_shared/internalTenant.ts explains why the literal stays out
-- of source). Exactly one tenant carries it today; this seeds whichever does.
select public.crm_seed_pipeline(cs.client_id, 'outreach')
  from public.client_settings cs where cs.internal_account is true;

-- ── PART 7 — checks ──────────────────────────────────────────────────────────────────────
do $chk$
declare
  v_t text := 'm301-rehearsal-' || substr(md5(random()::text), 1, 8);
  v_p uuid; v_s1 uuid; v_s2 uuid; v_lost uuid; v_r jsonb; v_r2 jsonb; v_n int;
begin
  -- Browser roles hold nothing on the new tables.
  if has_table_privilege('authenticated', 'public.crm_deals', 'select')
     or has_table_privilege('anon', 'public.crm_pipelines', 'select') then
    raise exception '301: browser roles can read the pipeline tables';
  end if;

  -- Rehearsal on a made-up tenant (no client_users rows, so no owner).
  v_p := public.crm_seed_pipeline(v_t, 'sales');
  if public.crm_seed_pipeline(v_t, 'sales') <> v_p then raise exception '301: seed is not idempotent'; end if;
  select count(*) into v_n from public.crm_pipeline_stages where pipeline_id = v_p;
  if v_n <> 6 then raise exception '301: sales seed made % stages', v_n; end if;
  select id into v_s1 from public.crm_pipeline_stages where pipeline_id = v_p order by position limit 1;
  select id into v_s2 from public.crm_pipeline_stages where pipeline_id = v_p and kind = 'won';
  select id into v_lost from public.crm_pipeline_stages where pipeline_id = v_p and kind = 'lost';

  v_r := public.crm_create_lead(v_t, 'Pat Rehearsal', 'Rehearsal Barns', '(555) 010-3011', 'pat@example.invalid', null, null, 'manual', v_s1);
  if (v_r->>'dealId') is null then raise exception '301: create_lead made no deal'; end if;
  -- Same phone, refuse mode → {existing}, nothing written.
  v_r2 := public.crm_create_lead(v_t, 'Pat Again', null, '555-010-3011', null, null, null, 'manual', v_s1);
  if (v_r2->>'existing') is distinct from (v_r->>'contactId') then raise exception '301: refuse did not report the match'; end if;
  -- Attach mode → second deal on the same contact.
  v_r2 := public.crm_create_lead(v_t, null, 'Other Co', null, 'PAT@example.invalid', null, null, 'import', v_s1, null, null, 'attach');
  if (v_r2->>'contactId') <> (v_r->>'contactId') then raise exception '301: attach did not match by email'; end if;
  if (select company from public.crm_contacts where id = (v_r->>'contactId')::uuid) <> 'Rehearsal Barns' then
    raise exception '301: attach overwrote a company';
  end if;

  -- Lost needs a reason.
  begin
    perform public.crm_move_deal(v_t, (v_r->>'dealId')::uuid, v_lost, null, null);
    raise exception '301: lost without a reason was accepted';
  exception when check_violation then null;
  end;
  v_r2 := public.crm_move_deal(v_t, (v_r->>'dealId')::uuid, v_lost, null, 'Price');
  if (select lost_at is null or lost_reason <> 'Price' from public.crm_deals where id = (v_r->>'dealId')::uuid) then
    raise exception '301: lost move did not stamp';
  end if;
  v_r2 := public.crm_move_deal(v_t, (v_r->>'dealId')::uuid, v_s2, null, null);
  if (select won_at is null or lost_at is not null or lost_reason is not null from public.crm_deals where id = (v_r->>'dealId')::uuid) then
    raise exception '301: won move did not clear lost';
  end if;
  select count(*) into v_n from public.crm_deal_stage_changes where deal_id = (v_r->>'dealId')::uuid;
  if v_n <> 3 then raise exception '301: expected 3 history rows, got %', v_n; end if;

  -- A stage from another tenant can never hold this tenant's deal (the composite FK).
  if exists (select 1 from public.crm_pipeline_stages where client_id <> v_t) then
    begin
      update public.crm_deals set stage_id = (select id from public.crm_pipeline_stages where client_id <> v_t limit 1)
       where id = (v_r->>'dealId')::uuid;
      if found then raise exception '301: cross-tenant stage accepted'; end if;
    exception when foreign_key_violation then null;
    end;
  end if;

  -- Clean the rehearsal away.
  delete from public.crm_pipelines where client_id = v_t;
  delete from public.crm_contacts where client_id = v_t;
  if exists (select 1 from public.crm_deals where client_id = v_t) then raise exception '301: rehearsal left deals'; end if;
end;
$chk$;

select (select count(*) from public.crm_pipelines where seed_kind = 'outreach') as outreach_pipelines,
       (select count(*) from public.crm_pipeline_stages s join public.crm_pipelines p on p.id = s.pipeline_id
         where p.seed_kind = 'outreach') as outreach_stages;

commit;
