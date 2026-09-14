-- 231_customer_design_links.sql — a signed-in customer's SAVED DESIGNS, and the builder's choice of
-- how login codes are sent by default.
--
-- Carolyn, 2026-09-14 (expo prep call): refreshing the designer must not lose the building, and a
-- customer who logs in should find the designs they were working on. Ahsan, 2026-09-15 (expo plan
-- 3.6): saved designs are tied to the VERIFIED login, and each builder picks Text or Email as the
-- default way a code is sent.
--
-- ── WHY A LINK TABLE, AND NOT "EVERY DRAFT WITH MY PHONE ON IT" ──────────────────────────
-- designs.contact is written by save_design, which anon may call and which stores the blob
-- verbatim. Anyone can therefore create a draft carrying YOUR phone or address. customer-quotes
-- already refuses to list drafts for exactly that reason (a silent capture the visitor never
-- knowingly created). A saved-designs list built from contact matching alone would hand a stranger
-- a way to put designs — and a thumbnail of their choosing — into your account.
--
-- So a draft appears in someone's list only after a session that PROVED that identity linked it
-- (customer-designs `link`, called by the designer's autosave while the customer is signed in),
-- and only while the design's contact still names that identity (customer-designs re-checks
-- ownsDesign when it lists). Listing reads links only; it never scans contacts.
--
--   public.customer_design_links   one row per (design, proven identity). EXACTLY ONE of
--       phone_digits / email_lower is set: a session that proved both writes one row for each
--       identity the design's contact actually matches, so a later login by either finds it and a
--       login by an identity the design does not name finds nothing. hidden_at is the customer's
--       "Remove" — the row stays (a re-link does not bring it back), the design is untouched.
--       SERVICE-ROLE ONLY: RLS on, zero policies, revoked from anon, authenticated AND public.
--       The 200-per-identity cap lives in the function (counted over rows not hidden).
--   public.client_settings.customer_login_default   'sms' | 'email' | null (= sms). Saved from
--       Settings → CRM Connection (portal-settings `save`, key customerLoginDefault) and read by
--       customer-auth login_options. A preference, never a permission: if the builder picks
--       email and email codes are not configured on the deployment, login_options still only
--       offers the channels that work. client_settings is already service-role only (checked
--       2026-09-15: RLS on, no policies, ACL postgres + service_role), and the new column inherits
--       that.
--
-- short_code cascades on delete (the invoice_requests 229 posture): a link to a design that no
-- longer exists is nothing. client_id is not a foreign key, like 229; the function writes the
-- session's own tenant and refuses a design from any other.
--
-- ── SAFE WITH WHAT IS LIVE TODAY ─────────────────────────────────────────────────────────
-- Nothing live reads or writes either object. The live portal never sends customerLoginDefault,
-- and live customer-auth never selects the column. Checked read-only on 2026-09-15:
-- customer_design_links does not exist, and client_settings has no customer_login_default.
--
-- ── ORDER OF APPLY AND DEPLOY ────────────────────────────────────────────────────────────
-- THIS MIGRATION FIRST, then customer-designs. Deployed before the table exists, every link /
-- list / hide answers 500 (logged) — the designer treats that as "saved designs unavailable",
-- nothing else breaks. customer-auth login_options tolerates the missing column (it falls back to
-- the deployment rule), and portal-settings only writes the column when the portal sends the key,
-- so those two are safe in either order. 230 must already be applied: customer-designs imports
-- _shared/customerSession.ts, which selects customer_sessions.email_lower.
--
-- Hand-apply via `supabase db query --linked` (SQL inline, NOT --file) or the SQL editor, and
-- record as version 231 — NEVER `supabase db push`. Rehearse inside begin … rollback first.
--
-- Rollback (revert customer-designs first; the portal field then saves into nothing):
--   alter table public.client_settings drop constraint if exists client_settings_customer_login_default_check;
--   alter table public.client_settings drop column if exists customer_login_default;
--   drop table if exists public.customer_design_links;

-- 1. The links.
create table if not exists public.customer_design_links (
  id            uuid        primary key default gen_random_uuid(),
  client_id     text        not null,
  short_code    text        not null references public.designs(short_code) on delete cascade,
  -- The proven identity this link belongs to. Exactly one is set (check below). Same
  -- normalisation as customer_sessions (230): 10 US digits; trimmed, lower-cased address.
  phone_digits  text,
  email_lower   text,
  created_at    timestamptz not null default now(),
  hidden_at     timestamptz,
  constraint customer_design_links_one_identity
    check (num_nonnulls(phone_digits, email_lower) = 1)
);

-- One link per design per identity. Partial, because each row carries only one of the two; the
-- function inserts and treats 23505 as "already linked" (PostgREST's onConflict cannot name a
-- partial index).
create unique index if not exists customer_design_links_phone_key
  on public.customer_design_links (client_id, phone_digits, short_code)
  where phone_digits is not null;
create unique index if not exists customer_design_links_email_key
  on public.customer_design_links (client_id, email_lower, short_code)
  where email_lower is not null;

alter table public.customer_design_links enable row level security;

-- No policies → service_role only. Revoke PUBLIC explicitly: this project's default privileges
-- make every NEW table world-readable, and that grant survives a revoke aimed only at the roles.
revoke all on public.customer_design_links from public;
revoke all on public.customer_design_links from anon, authenticated;

comment on table public.customer_design_links is
  'Migration 231. A draft design a signed-in customer saved, keyed on the identity their session proved (exactly one of phone_digits / email_lower). Written by customer-designs link (only when the design''s contact matches that identity), read by customer-designs list, hidden by customer-designs hide. Service-role only.';
comment on column public.customer_design_links.hidden_at is
  'Migration 231. The customer removed it from Saved designs. The row is kept so a re-link does not bring it back; the design itself is untouched.';

-- 2. The builder's default login channel.
alter table public.client_settings
  add column if not exists customer_login_default text;
alter table public.client_settings
  drop constraint if exists client_settings_customer_login_default_check;
alter table public.client_settings
  add constraint client_settings_customer_login_default_check
  check (customer_login_default is null or customer_login_default in ('sms', 'email'));

comment on column public.client_settings.customer_login_default is
  'Migration 231. How the designer''s login sheet sends a code first: ''sms'' (text) or ''email''; null means text. A preference only — customer-auth login_options offers just the channels the deployment can deliver.';

-- ── Apply-time assertions. These RAISE. ──────────────────────────────────────────────────
do $$
declare
  r text;
begin
  -- Shape.
  if not exists (select 1 from pg_constraint
                  where conname = 'customer_design_links_one_identity' and contype = 'c' and convalidated) then
    raise exception '231: customer_design_links_one_identity is missing or not validated';
  end if;
  if (select count(*) from pg_indexes
       where schemaname = 'public' and tablename = 'customer_design_links'
         and indexname in ('customer_design_links_phone_key', 'customer_design_links_email_key')) <> 2 then
    raise exception '231: a customer_design_links unique index is missing';
  end if;
  if not exists (select 1 from pg_constraint
                  where conrelid = 'public.customer_design_links'::regclass and contype = 'f'
                    and confrelid = 'public.designs'::regclass and confdeltype = 'c') then
    raise exception '231: customer_design_links.short_code must reference designs on delete cascade';
  end if;
  if not exists (select 1 from information_schema.columns
                  where table_schema = 'public' and table_name = 'client_settings'
                    and column_name = 'customer_login_default' and data_type = 'text') then
    raise exception '231: client_settings.customer_login_default is missing';
  end if;
  if not exists (select 1 from pg_constraint
                  where conname = 'client_settings_customer_login_default_check' and contype = 'c' and convalidated) then
    raise exception '231: client_settings_customer_login_default_check is missing or not validated';
  end if;

  -- Service-role only, both tables.
  foreach r in array array['public.customer_design_links', 'public.client_settings'] loop
    if not (select relrowsecurity from pg_class where oid = r::regclass) then
      raise exception '231: RLS is off on %', r;
    end if;
    if exists (select 1 from pg_policies where schemaname || '.' || tablename = r) then
      raise exception '231: % has a policy — it must be service-role only', r;
    end if;
    if has_table_privilege('anon', r, 'SELECT,INSERT,UPDATE,DELETE')
       or has_table_privilege('authenticated', r, 'SELECT,INSERT,UPDATE,DELETE') then
      raise exception '231: anon or authenticated holds a privilege on %', r;
    end if;
    if exists (select 1 from pg_class c, aclexplode(coalesce(c.relacl, acldefault('r', c.relowner))) a
                where c.oid = r::regclass and a.grantee = 0) then
      raise exception '231: PUBLIC holds a privilege on %', r;
    end if;
  end loop;

  raise notice '231: customer_design_links ready (% rows); client_settings.customer_login_default set on % tenant(s)',
    (select count(*) from public.customer_design_links),
    (select count(*) from public.client_settings where customer_login_default is not null);
end $$;
