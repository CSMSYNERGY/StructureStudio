-- 157_setup_and_comment_threads: two-way submission threads + the tenant SETUP checklist.
--
-- Carolyn 2026-08-28, once dev work had moved off Monday into Projects: builders should
-- see their submissions "in real flow" and be able to REPLY on their own items (this
-- becomes a communication channel), and new builders should get an ordered list of setup
-- steps assigned to them automatically from an operator-maintained template.
--
-- ⚠️ APPLY BY HAND (SQL editor / MCP) and record in supabase_migrations.schema_migrations.
-- NEVER `supabase db push`. APPLIED LIVE + LEDGERED as version 157 on 2026-08-28 — the
-- LEDGER is the source of truth for the next free number, not this folder (it carries
-- duplicate prefixes and gaps from parallel working lines).

-- ── Part 1: who wrote a comment ─────────────────────────────────────────────
-- Every feedback_comments row until now was team-sourced (Monday's /client updates, or an
-- operator publishing from Projects), so 'team' is the correct default for history.
-- The tenant's own replies are inserted by portal-feedback's `comment` action with
-- monday_update_id NULL, which is what keeps them safe: every Monday reconcile path
-- deletes only `.eq("monday_update_id", …)`, so a NULL-keyed row is never touched.
alter table public.feedback_comments
  add column if not exists author_kind text not null default 'team'
    check (author_kind in ('team','client'));
alter table public.feedback_comments add column if not exists author_user_id uuid;

-- A client reply becomes a first-class entry in the team's Projects thread. ⚠️ For a
-- pm_updates row with author_kind='client', the pm_update is the COPY and the tenant's
-- feedback_comments row is the ORIGINAL — portal-projects' delete_update must never
-- cascade into it (a delete there would erase the customer's own words).
alter table public.pm_updates
  add column if not exists author_kind text not null default 'operator'
    check (author_kind in ('operator','client'));

-- ── Part 2a: the template (operator-only) ───────────────────────────────────
-- Internal posture, same as pm_* / app_operators: RLS on, ZERO policies, revoked from
-- both browser roles. A tenant never reads the template; they only ever see their own
-- copied rows in tenant_setup_items.
create table if not exists public.setup_template_items (
  id         uuid primary key default gen_random_uuid(),
  title      text not null,
  detail     text,
  link_page  text,                                   -- optional portal deep link, e.g. "settings/branding"
  position   double precision not null default 1024,
  active     boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists setup_template_items_pos_idx on public.setup_template_items (active, position);
alter table public.setup_template_items enable row level security;
revoke all on public.setup_template_items from anon, authenticated;

-- ── Part 2b: a tenant's own list (tenant-readable, migration 054's pattern) ──
-- COPIES, not references: the template can be edited or reordered later without
-- rewriting what a builder is already working through. template_item_id keeps the
-- provenance and goes NULL if the template row is deleted.
--
-- Read-only to the tenant with ZERO write policies: ticking an item goes through
-- portal-setup so the attribution (who completed it, client or team) is derived
-- server-side from the caller's identity and cannot be forged from the browser.
create table if not exists public.tenant_setup_items (
  id               uuid primary key default gen_random_uuid(),
  client_id        text not null,
  template_item_id uuid references public.setup_template_items(id) on delete set null,
  title            text not null,
  detail           text,
  link_page        text,
  position         double precision not null default 1024,
  completed_at     timestamptz,
  completed_by_kind text check (completed_by_kind in ('client','team')),
  completed_by_name text,
  created_at       timestamptz not null default now()
);
create index if not exists tenant_setup_items_client_idx on public.tenant_setup_items (client_id, position);

alter table public.tenant_setup_items enable row level security;
drop policy if exists tenant_setup_items_tenant_read on public.tenant_setup_items;
create policy tenant_setup_items_tenant_read on public.tenant_setup_items
  for select to authenticated using (client_id = public.current_client_id());
grant select on public.tenant_setup_items to authenticated;
revoke all on public.tenant_setup_items from anon;
-- Load-bearing: Supabase's default public-schema grants hand out ALL privileges, so the
-- read-only posture only holds if the writes are explicitly revoked (054's lesson).
revoke insert, update, delete, truncate, references, trigger
  on public.tenant_setup_items from authenticated;

-- ── Seed the template with today's manual onboarding order ─────────────────
-- This is the checklist that has been living in the admin console's success message
-- ("Next: give the owner a login on the Account tab, then styles, items and pricing"),
-- written for the builder rather than for us. Operators edit it in Projects → Setup.
insert into public.setup_template_items (title, detail, link_page, position)
select * from (values
 ('Set your password and sign in', 'Use the link we sent you, then set a password you will remember. Everything below happens inside this portal.', null, 1024),
 ('Add your business details and logo', 'Name, phone, address and logo — these appear on every quote your customers receive.', 'settings/branding', 2048),
 ('Check your building styles and sizes', 'We started you from our master catalog. Remove what you do not sell and correct the sizes you do.', 'settings/structures', 3072),
 ('Set your prices', 'Base prices per size. A size with no price is not offered to customers, so this is what turns the designer on.', 'settings/structures', 4096),
 ('Review your doors, windows and add-ons', 'Names, sizes and prices for the items customers place on a building.', 'settings/options', 5120),
 ('Set your colors', 'Your paint and roof colors, with the names your customers know them by.', 'settings/colors', 6144),
 ('Connect your CRM', 'Point estimates at your GoHighLevel account so leads land where you already work.', 'settings/connection', 7168),
 ('Send yourself a test quote', 'Build one design end to end and submit it. Confirm the email and PDF look the way you want before you share your link.', 'designer', 8192)
) as v(title, detail, link_page, position)
where not exists (select 1 from public.setup_template_items);

-- Rollback:
--   drop table public.tenant_setup_items;
--   drop table public.setup_template_items;
--   alter table public.pm_updates drop column author_kind;
--   alter table public.feedback_comments drop column author_kind, drop column author_user_id;
