-- 325_lead_forms.sql — website lead forms, their submissions and daily counts, and designed email
-- templates (Settings → Customer Hub → Forms / Email Templates).
--
-- ⛔ APPLY BY HAND, AFTER A HUMAN HAS READ IT. Pipe this file to `supabase db query --linked`
--    (stdin; NOT `--file`, see 270's header), then record it:
--      insert into supabase_migrations.schema_migrations (version, name) values ('325', '325_lead_forms') returning version, name;
--    NEVER `supabase db push`. The file carries its own begin;/commit;.
--
--    REHEARSAL (changes nothing):
--      sed 's/^commit;\r\{0,1\}$/rollback;/' supabase/migrations/325_lead_forms.sql | npx supabase db query --linked -o csv
--
-- ── WHY (Carolyn 2026-10-22) ─────────────────────────────────────────────────────────────
-- "I want to start planning out a designer to build out forms for websites so we can capture
-- leads, and build out email templates ... This should go into the customer hub settings tab."
-- A GoHighLevel-style form builder: the builder designs a form, publishes it, and pastes one
-- snippet into their own website. Every submission becomes a CRM contact; the builder gets an
-- alert and the visitor a designed auto-reply.
--
-- ── WHAT THIS ADDS ───────────────────────────────────────────────────────────────────────
--   1. lead_forms — one row per form. `definition` is the DRAFT the designer edits;
--      `published_definition` is what the website serves. They are apart on purpose: editing a
--      live form must never change the live page until the builder presses Publish.
--   2. lead_form_submissions — every submission, written FIRST by the lead-form edge function so
--      a lead survives any later failure (contact, deal, email). Spam is kept, flagged.
--   3. lead_form_daily_stats — views / starts / submits per form per day, bumped by
--      lead_form_bump(). A counter, not a row per page view.
--   4. email_templates — designed emails (blocks + global styles in `design`).
--   5. email_sends.kind gains 'form_autoreply' and 'form_notification' (mirrors TenantMail.kind
--      in _shared/emailSend.ts — changed in the same commit).
--   6. crm_contacts.source and crm_deals.source gain 'form'.
--   7. storage bucket form-assets — PUBLIC read (form header images and email images are shown
--      on public pages and in inboxes), images only, 5 MB, writes by service-role signed URL.
--
-- Every table: RLS on, tenants SELECT their own rows, NO anon policy, every write through the
-- service role in an edge function (portal-settings for staff, lead-form for the public).
-- There is no anon read path in SQL: the public page loads its form through the lead-form edge
-- function, which returns only the published definition (never the draft, the notification
-- recipients or the template ids).

begin;

-- ── 1. Forms ─────────────────────────────────────────────────────────────────────────────
create table if not exists public.lead_forms (
  id uuid primary key default gen_random_uuid(),
  client_id text not null,
  name text not null check (char_length(btrim(name)) between 1 and 120),
  status text not null default 'draft' check (status in ('draft', 'published', 'archived')),
  definition jsonb not null default '{}'::jsonb,
  published_definition jsonb,
  published_version integer not null default 0 check (published_version >= 0),
  published_at timestamptz,
  settings jsonb not null default '{}'::jsonb,
  created_by uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  -- A runaway definition is a runaway public payload: cap both copies.
  constraint lead_forms_definition_size check (pg_column_size(definition) <= 200000),
  constraint lead_forms_published_size check (published_definition is null or pg_column_size(published_definition) <= 200000),
  constraint lead_forms_settings_size check (pg_column_size(settings) <= 20000),
  constraint lead_forms_published_shape check (status <> 'published' or published_definition is not null)
);
create index if not exists lead_forms_client on public.lead_forms (client_id, updated_at desc);
alter table public.lead_forms enable row level security;
drop policy if exists lead_forms_owner_select on public.lead_forms;
create policy lead_forms_owner_select on public.lead_forms
  for select to authenticated using (client_id = public.current_client_id());

-- ── 2. Submissions ───────────────────────────────────────────────────────────────────────
create table if not exists public.lead_form_submissions (
  id uuid primary key default gen_random_uuid(),
  client_id text not null,
  form_id uuid not null references public.lead_forms(id) on delete cascade,
  form_version integer not null default 0,
  -- [{ id, label, type, value }] in the form's field order, as validated by the server.
  answers jsonb not null default '[]'::jsonb,
  contact_id uuid references public.crm_contacts(id) on delete set null,
  deal_id uuid references public.crm_deals(id) on delete set null,
  page_url text check (page_url is null or char_length(page_url) <= 500),
  referrer text check (referrer is null or char_length(referrer) <= 500),
  utm jsonb not null default '{}'::jsonb,
  spam boolean not null default false,
  spam_reason text,
  notify_error text,
  created_at timestamptz not null default now(),
  constraint lead_form_submissions_answers_size check (pg_column_size(answers) <= 60000)
);
create index if not exists lead_form_submissions_form on public.lead_form_submissions (form_id, created_at desc);
-- Index-backed per-tenant rate limit in lead-form (the capture-lead Guard 1 shape).
create index if not exists lead_form_submissions_client on public.lead_form_submissions (client_id, created_at desc);
alter table public.lead_form_submissions enable row level security;
drop policy if exists lead_form_submissions_owner_select on public.lead_form_submissions;
create policy lead_form_submissions_owner_select on public.lead_form_submissions
  for select to authenticated using (client_id = public.current_client_id());

-- ── 3. Daily counts ──────────────────────────────────────────────────────────────────────
create table if not exists public.lead_form_daily_stats (
  form_id uuid not null references public.lead_forms(id) on delete cascade,
  client_id text not null,
  day date not null,
  views integer not null default 0,
  starts integer not null default 0,
  submits integer not null default 0,
  primary key (form_id, day)
);
create index if not exists lead_form_daily_stats_client on public.lead_form_daily_stats (client_id, day desc);
alter table public.lead_form_daily_stats enable row level security;
drop policy if exists lead_form_daily_stats_owner_select on public.lead_form_daily_stats;
create policy lead_form_daily_stats_owner_select on public.lead_form_daily_stats
  for select to authenticated using (client_id = public.current_client_id());

-- One atomic bump, service role only. p_kind is checked here so a caller can never name a
-- column it should not touch.
create or replace function public.lead_form_bump(p_form_id uuid, p_client_id text, p_kind text)
returns void
language plpgsql
security definer
set search_path to ''
as $$
begin
  if p_kind not in ('views', 'starts', 'submits') then
    raise exception 'lead_form_bump: bad kind %', p_kind;
  end if;
  insert into public.lead_form_daily_stats (form_id, client_id, day, views, starts, submits)
  values (p_form_id, p_client_id, (now() at time zone 'utc')::date,
          (p_kind = 'views')::int, (p_kind = 'starts')::int, (p_kind = 'submits')::int)
  on conflict (form_id, day) do update set
    views = public.lead_form_daily_stats.views + (p_kind = 'views')::int,
    starts = public.lead_form_daily_stats.starts + (p_kind = 'starts')::int,
    submits = public.lead_form_daily_stats.submits + (p_kind = 'submits')::int;
end
$$;
revoke execute on function public.lead_form_bump(uuid, text, text) from public, anon, authenticated;
grant execute on function public.lead_form_bump(uuid, text, text) to service_role;

-- ── 4. Email templates ───────────────────────────────────────────────────────────────────
create table if not exists public.email_templates (
  id uuid primary key default gen_random_uuid(),
  client_id text not null,
  name text not null check (char_length(btrim(name)) between 1 and 120),
  purpose text not null default 'general' check (purpose in ('form_autoreply', 'form_notification', 'general')),
  subject text not null default '' check (char_length(subject) <= 200),
  preheader text not null default '' check (char_length(preheader) <= 200),
  design jsonb not null default '{}'::jsonb,
  created_by uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint email_templates_design_size check (pg_column_size(design) <= 200000)
);
create index if not exists email_templates_client on public.email_templates (client_id, updated_at desc);
alter table public.email_templates enable row level security;
drop policy if exists email_templates_owner_select on public.email_templates;
create policy email_templates_owner_select on public.email_templates
  for select to authenticated using (client_id = public.current_client_id());

-- ── 5. email_sends kinds (mirrors TenantMail.kind) ───────────────────────────────────────
alter table public.email_sends drop constraint if exists email_sends_kind_check;
alter table public.email_sends add constraint email_sends_kind_check
  check (kind = any (array['estimate', 'invoice', 'test', 'acceptance', 'change_order',
                           'conversation', 'login_code', 'form_autoreply', 'form_notification']));

-- ── 6. 'form' as a contact and deal source ───────────────────────────────────────────────
alter table public.crm_contacts drop constraint if exists crm_contacts_source_check;
alter table public.crm_contacts add constraint crm_contacts_source_check
  check (source = any (array['design', 'captured_lead', 'manual', 'import', 'phone', 'ghl_import', 'booking', 'form']));
alter table public.crm_deals drop constraint if exists crm_deals_source_check;
alter table public.crm_deals add constraint crm_deals_source_check
  check (source = any (array['manual', 'import', 'booking', 'phone', 'design', 'form']));

-- ── 7. Image bucket ──────────────────────────────────────────────────────────────────────
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('form-assets', 'form-assets', true, 5242880, array['image/jpeg', 'image/png', 'image/webp', 'image/gif'])
on conflict (id) do update
  set public = true, file_size_limit = 5242880, allowed_mime_types = array['image/jpeg', 'image/png', 'image/webp', 'image/gif'];

-- ── THE RECORD ───────────────────────────────────────────────────────────────────────────
select
  '325' as migration,
  to_regclass('public.lead_forms') is not null as forms,
  to_regclass('public.lead_form_submissions') is not null as submissions,
  to_regclass('public.lead_form_daily_stats') is not null as stats,
  to_regclass('public.email_templates') is not null as templates,
  has_function_privilege('anon', 'public.lead_form_bump(uuid,text,text)', 'execute') as anon_can_bump,
  exists (select 1 from storage.buckets where id = 'form-assets' and public) as bucket;

commit;
