-- 230_customer_identity_email.sql — a customer session (and the acceptance it signs) can be
-- keyed on a verified EMAIL ADDRESS, not only a phone.
--
-- Ahsan, 2026-09-15 (Carolyn 09-14 expo plan, decision 3): "Text AND email login codes before
-- the expo." The designer's gate becomes a login at the Shed Show Expo, and a shopper whose
-- phone cannot take a text (or a builder whose texting is not approved yet) still needs a way in.
--
-- ── WHY THE SCHEMA HAS TO CHANGE ─────────────────────────────────────────────────────────
-- customer-auth has had an email channel since 2026-08-30, but customer_sessions.phone_digits
-- is NOT NULL (108), so that channel proved an address and then minted the session on a PHONE
-- it read off a design's contact blob. save_design (anon) stores that blob verbatim: pair your
-- own inbox with someone else's number, verify your own code, and the session was theirs. It
-- was switched off on 2026-09-06, with the note that re-opening it needs exactly this: a
-- session keyed on the verified address itself, and ownership checks that match like with like
-- (_shared/customerIdentity.ts ownsDesign — never an email resolved to a phone).
--
--   public.customer_sessions   phone_digits becomes NULLABLE; new email_lower (normalizeEmail:
--       trimmed, lower-cased). Each is null unless a code sent to it was proven. A session may
--       hold both (the same person verified by text and by email — customerSession.addIdentity).
--       CHECK customer_sessions_identity_present: at least one. Partial index on
--       (client_id, email_lower), the twin of customer_sessions_client_phone_idx.
--   public.design_acceptances  the same nullable phone_digits + email_lower + CHECK. The row is
--       e-signature evidence of WHO agreed; an acceptance made under an email session records
--       the address it proved and a null phone, never a phone read off the design.
--
-- Deliberately NOT a CHECK that email_lower = lower(btrim(email_lower)): JavaScript's
-- toLowerCase and Postgres lower() disagree on some non-ASCII letters, and a disagreement would
-- turn a sign-in into a 500 at mint time. The edge function owns normalisation (one place).
--
-- ── GRANTS ───────────────────────────────────────────────────────────────────────────────
-- customer_sessions stays service-role only. 108 revoked anon and authenticated but never
-- PUBLIC; the live ACL holds no PUBLIC entry today (checked 2026-09-15), and the revoke is
-- re-run anyway because this project's default privileges grant PUBLIC on new objects and the
-- grant survives a revoke aimed only at the two roles.
-- design_acceptances KEEPS `grant select to authenticated` (124): the portal reads its own
-- tenant's signatures through the area policy (194). The new column inherits that table-level
-- SELECT, the same exposure phone_digits already has — a builder's team sees the address their
-- own customer signed with. No write grant exists or is added.
--
-- ── SAFE WITH THE FUNCTIONS THAT ARE LIVE TODAY ──────────────────────────────────────────
-- Live customer-auth mints phone sessions only and live customer-accept writes phone_digits on
-- every acceptance (portal-settings' rep-attested acceptance refuses a contact without a
-- 10-digit phone), so neither CHECK can refuse anything they do. Counted read-only on live,
-- 2026-09-15: 17 sessions and 26 acceptances, none with a blank phone_digits; 0 email codes
-- ever issued (customer_email_otps).
--
-- ── ORDER OF APPLY AND DEPLOY ────────────────────────────────────────────────────────────
-- THIS MIGRATION FIRST. The new _shared/customerSession.ts selects email_lower: deployed before
-- the column exists, checkSession errors, answers null, and EVERY customer is told their session
-- expired. Then customer-quotes, customer-accept and customer-pay, and customer-auth LAST — it
-- is the one that mints email-only sessions, which the old ownership checks would treat as
-- owning nothing.
--
-- Hand-apply via `supabase db query --linked` (SQL inline, NOT --file) or the SQL editor, and
-- record as version 230 — NEVER `supabase db push`. Rehearse inside begin … rollback first
-- (scratchpad integration/230-rehearsal.sql).
--
-- Rollback — revert customer-auth FIRST (so no new email-only rows appear), then:
--   delete from public.customer_sessions where phone_digits is null;   -- signs those customers out
--   drop index if exists public.customer_sessions_client_email_idx;
--   alter table public.customer_sessions drop constraint if exists customer_sessions_identity_present;
--   alter table public.customer_sessions drop column if exists email_lower;
--   alter table public.customer_sessions alter column phone_digits set not null;
--   ⚠️ design_acceptances: only if `select count(*) from public.design_acceptances where
--   phone_digits is null` is 0. An email-signed acceptance is evidence and must not be deleted to
--   restore a constraint — leave that half applied (the nullable column is harmless to old code).
--   alter table public.design_acceptances drop constraint if exists design_acceptances_identity_present;
--   alter table public.design_acceptances drop column if exists email_lower;
--   alter table public.design_acceptances alter column phone_digits set not null;

-- 1. Sessions.
alter table public.customer_sessions
  alter column phone_digits drop not null;
alter table public.customer_sessions
  add column if not exists email_lower text;
alter table public.customer_sessions
  drop constraint if exists customer_sessions_identity_present;
alter table public.customer_sessions
  add constraint customer_sessions_identity_present
  check (phone_digits is not null or email_lower is not null);

create index if not exists customer_sessions_client_email_idx
  on public.customer_sessions (client_id, email_lower)
  where email_lower is not null;

revoke all on public.customer_sessions from public;
revoke all on public.customer_sessions from anon, authenticated;

comment on column public.customer_sessions.phone_digits is
  'Migration 108; nullable since 230. The 10 US digits a Twilio Verify code was proven against, or null when this session was not verified by text.';
comment on column public.customer_sessions.email_lower is
  'Migration 230. The trimmed, lower-cased address an emailed code was proven against, or null. Never derived from a design''s contact. At least one of phone_digits / email_lower is set.';

-- 2. Acceptances.
alter table public.design_acceptances
  alter column phone_digits drop not null;
alter table public.design_acceptances
  add column if not exists email_lower text;
alter table public.design_acceptances
  drop constraint if exists design_acceptances_identity_present;
alter table public.design_acceptances
  add constraint design_acceptances_identity_present
  check (phone_digits is not null or email_lower is not null);

revoke all on public.design_acceptances from public;

comment on column public.design_acceptances.email_lower is
  'Migration 230. The verified address of the customer session that agreed, or null (a text-verified session, or a rep-attested acceptance). Evidence of who signed; never read off the design.';

-- ── Apply-time assertions. These RAISE. ──────────────────────────────────────────────────
do $$
declare
  r text;
begin
  -- Shape.
  if exists (select 1 from information_schema.columns
              where table_schema = 'public' and table_name in ('customer_sessions', 'design_acceptances')
                and column_name = 'phone_digits' and is_nullable = 'NO') then
    raise exception '230: phone_digits is still NOT NULL on a table';
  end if;
  if (select count(*) from information_schema.columns
       where table_schema = 'public' and table_name in ('customer_sessions', 'design_acceptances')
         and column_name = 'email_lower' and data_type = 'text') <> 2 then
    raise exception '230: email_lower is missing from customer_sessions or design_acceptances';
  end if;
  if (select count(*) from pg_constraint
       where conname in ('customer_sessions_identity_present', 'design_acceptances_identity_present')
         and contype = 'c' and convalidated) <> 2 then
    raise exception '230: an identity_present check is missing or not validated';
  end if;
  if not exists (select 1 from pg_indexes
                  where schemaname = 'public' and indexname = 'customer_sessions_client_email_idx') then
    raise exception '230: customer_sessions_client_email_idx is missing';
  end if;

  -- customer_sessions: service-role only, exactly as 108 meant.
  if not (select relrowsecurity from pg_class where oid = 'public.customer_sessions'::regclass) then
    raise exception '230: RLS is off on customer_sessions';
  end if;
  if exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'customer_sessions') then
    raise exception '230: customer_sessions has a policy — it must be service-role only';
  end if;
  foreach r in array array['anon', 'authenticated'] loop
    if has_table_privilege(r, 'public.customer_sessions', 'SELECT,INSERT,UPDATE,DELETE') then
      raise exception '230: % holds a privilege on customer_sessions', r;
    end if;
  end loop;
  if exists (select 1 from pg_class c, aclexplode(coalesce(c.relacl, acldefault('r', c.relowner))) a
              where c.oid = 'public.customer_sessions'::regclass and a.grantee = 0) then
    raise exception '230: PUBLIC holds a privilege on customer_sessions';
  end if;

  -- design_acceptances: owner-read for the portal, writes service-role only (124 / 213).
  if has_table_privilege('anon', 'public.design_acceptances', 'SELECT,INSERT,UPDATE,DELETE') then
    raise exception '230: anon holds a privilege on design_acceptances';
  end if;
  if has_table_privilege('authenticated', 'public.design_acceptances', 'INSERT,UPDATE,DELETE') then
    raise exception '230: authenticated can write design_acceptances';
  end if;
  if exists (select 1 from pg_policies
              where schemaname = 'public' and tablename = 'design_acceptances' and cmd <> 'SELECT') then
    raise exception '230: design_acceptances has a non-SELECT policy';
  end if;
  if exists (select 1 from pg_class c, aclexplode(coalesce(c.relacl, acldefault('r', c.relowner))) a
              where c.oid = 'public.design_acceptances'::regclass and a.grantee = 0) then
    raise exception '230: PUBLIC holds a privilege on design_acceptances';
  end if;

  raise notice '230: customer_sessions and design_acceptances accept an email identity (% sessions, % acceptances, all phone-keyed until customer-auth ships)',
    (select count(*) from public.customer_sessions), (select count(*) from public.design_acceptances);
end $$;
