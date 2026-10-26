-- 291_payment_attempt_fields.sql — every card attempt records which fields it sent and what the
-- card's bank said about them.
--
-- ⛔ APPLY BY HAND, AFTER A HUMAN HAS READ IT. Pipe this file to `supabase db query --linked`
--    (stdin; see 270's header for why not `--file` or an inline "$(cat …)"), then record it:
--      insert into supabase_migrations.schema_migrations (version, name) values ('291', '291_payment_attempt_fields') returning version;
--    NEVER `supabase db push`. The file carries its own begin;/commit;, so a failed check anywhere
--    takes the whole migration with it. `db query` prints no NOTICE, only the last statement's rows:
--    THE RECORD at the end is what the apply shows. No row printed means the file did not run. To
--    see the same row and change nothing, pipe it with the last `commit;` swapped for `rollback;`.
--
-- ── NUMBERING: 291 IS TENTATIVE ──────────────────────────────────────────────────────────
-- Written 2026-10-09 on a branch off beta, where 289 is the newest file; 290 (tax codes) and 292
-- (Twilio accounts) are planned on sibling branches. RENUMBER AT APPLY if 291 is taken: read the
-- ledger first, and record the row with `returning` (no row back means the number was taken, so
-- rename the file and its test).
--   select version from supabase_migrations.schema_migrations order by 1 desc limit 3;
--
-- ── WHY ──────────────────────────────────────────────────────────────────────────────────
-- Fiserv's certification asks what every sale sends and what came back. Until now the attempt
-- ledger (174) could answer neither:
--   * which fields the auth carried. No page sent a street or a ZIP at all, so AVS never ran, and
--     there was no record to prove it either way. `sent_fields` is the list of field NAMES the
--     gateway was sent (never a value: the account is a token or track data), written on the
--     attempt BEFORE the card is touched, from the same body builder the request is made from
--     (_shared/cardpointe.ts cpAuthFieldNames), so the record cannot drift from the request;
--   * which ecomind went out. Swipes were sent "R", which CardPointe defines as RECURRING, not
--     retail. A swipe now sends none, and `ecomind` says what each attempt sent (null = none);
--   * what the bank said about the street/ZIP and the security code. `payments.avs_result` and
--     `cvv_result` (174) hold that for a sale that was RECORDED, and a decline records no payment.
--     So a mismatching CVV that declined left nothing to compare with a matching one, which is the
--     whole of the CVV proof. `avsresp` and `cvvresp` go on the attempt, approved or declined.
--
-- ── WHAT THIS DOES ───────────────────────────────────────────────────────────────────────
--   * Four NULLABLE columns on public.payment_attempts, no default: sent_fields text[],
--     ecomind text, avsresp text, cvvresp text. Adding a nullable column with no default is a
--     catalog change: no rewrite and no scan, and no existing row moves (they read null, which
--     means "written before 291").
--   * A comment on each.
--   * Nothing else: no index, no constraint, no trigger, no policy, no grant.
--
-- ── RLS AND GRANTS: EXACTLY AS 174 LEFT THEM ─────────────────────────────────────────────
-- 174 made the table service-role only: RLS on, ZERO policies, `revoke all ... from anon,
-- authenticated`. Table-level privileges cover columns added later, so the new columns inherit
-- that and nothing is granted or revoked here. The checks below prove it per column: neither browser
-- role can read or write any of the four, service_role can, RLS is on and no policy exists.
--
-- ── SAFE WITH WHAT IS LIVE ───────────────────────────────────────────────────────────────
-- Beta and production share this database. The functions that write these columns (customer-pay
-- and portal-payments, built from this branch) also write without them: on 42703/PGRST204 they
-- retry the same insert/update without the four keys (_shared/invoicePayment.ts M291_KEYS). So the
-- order between this file and those deploys cannot stop a charge. Still apply this FIRST, so the
-- very first attempt after the deploy carries its fields. Functions deployed before this branch
-- never name the columns. The file locks payment_attempts against writes from before its snapshot
-- to its commit (EXCLUSIVE, then the ADD COLUMN's brief ACCESS EXCLUSIVE). Every charge writes that
-- table, so lock_timeout makes a hung apply give up instead of queueing them.
-- `notify pgrst` at the end reloads PostgREST's schema cache, or the new columns would answer
-- PGRST204 until it next reloaded on its own.
--
-- ── ROLLBACK ─────────────────────────────────────────────────────────────────────────────
--   alter table public.payment_attempts drop column if exists sent_fields, drop column if exists ecomind, drop column if exists avsresp, drop column if exists cvvresp;
--   notify pgrst, 'reload schema';
--   delete from supabase_migrations.schema_migrations where version = '291';
-- Safe while the functions above are live: their writes fall back to the row they wrote before
-- 291. What is lost is the record itself, the field list and AVS/CVV answer of every attempt so far.

begin;

-- The ALTER takes ACCESS EXCLUSIVE on payment_attempts (brief: a catalog change). A hung apply must
-- give up rather than sit in front of every charge's attempt insert.
set local lock_timeout = '5s';

-- Writes stop HERE, before the snapshot, not at the ALTER below (281's order). Without it a charge
-- inserting or closing its attempt between the two statements made the "no row moved" check fail
-- the apply at a busy moment. EXCLUSIVE still lets a read through; an attempt insert waits the
-- few milliseconds this file takes. Held to the commit.
lock table public.payment_attempts in exclusive mode;

-- Every row BEFORE anything here runs, whole, so the checks can prove no row moved. As jsonb so the
-- same snapshot works on a first apply (no 291 columns yet) and on a re-apply (columns present and
-- already filled by real charges, which must not read as "moved").
create temp table m291_before on commit drop as
  select pa.id, to_jsonb(pa) as snap from public.payment_attempts pa;

-- ── THE CHANGE ───────────────────────────────────────────────────────────────────────────
alter table public.payment_attempts
  add column if not exists sent_fields text[],
  add column if not exists ecomind     text,
  add column if not exists avsresp     text,
  add column if not exists cvvresp     text;

comment on column public.payment_attempts.sent_fields is
  'The NAMES of the fields the CardPointe /auth request carried, sorted (cardpointe.ts cpAuthFieldNames), '
  'written before the card is touched. Never a value. NULL = written before migration 291.';
comment on column public.payment_attempts.ecomind is
  'The ecomind the auth was sent with: E for a keyed card. NULL with sent_fields set = none was sent, '
  'which is what a card-present swipe sends (CardPointe defines R as recurring). NULL with sent_fields '
  'NULL = written before migration 291.';
comment on column public.payment_attempts.avsresp is
  'The gateway''s AVS answer (street/ZIP), kept on the attempt whether the sale was approved or '
  'declined. A declined sale has no payments row, so this is the only place it is kept.';
comment on column public.payment_attempts.cvvresp is
  'The gateway''s CVV answer, kept on the attempt whether the sale was approved or declined. A '
  'declined sale has no payments row, so this is the only place it is kept.';

-- ── CHECKS: raise (and so roll the whole file back) rather than commit a surprise ───────
do $check$
declare
  v_col   text;
  v_want  text;
  v_got   record;
  v_role  text;
  v_priv  text;
  v_moved text;
begin
  -- ── The four columns: the right type, nullable, no default ──
  foreach v_col in array array['sent_fields', 'ecomind', 'avsresp', 'cvvresp'] loop
    v_want := case when v_col = 'sent_fields' then '_text' else 'text' end;
    select c.udt_name, c.is_nullable, c.column_default into v_got
      from information_schema.columns c
     where c.table_schema = 'public' and c.table_name = 'payment_attempts' and c.column_name = v_col;
    if v_got.udt_name is null then
      raise exception '291: payment_attempts.% is missing (is migration 174 applied?)', v_col;
    end if;
    if v_got.udt_name <> v_want or v_got.is_nullable <> 'YES' or v_got.column_default is not null then
      raise exception '291: payment_attempts.% should be % NULL with no default, is % / nullable % / default %',
        v_col, v_want, v_got.udt_name, v_got.is_nullable, v_got.column_default;
    end if;
  end loop;

  -- ── No existing row moved: every value as it was, and nothing back-filled into the new columns ──
  -- (a row is moved when it is gone, a value changed, or a column the snapshot did not have, this
  -- file's, holds anything but null)
  v_moved := (select string_agg(b.id::text, ', ' order by b.id)
       from m291_before b
       left join public.payment_attempts pa on pa.id = b.id
      where pa.id is null
         or exists (select 1 from jsonb_each(to_jsonb(pa)) e
                     where e.value is distinct from coalesce(b.snap -> e.key, 'null'::jsonb)));
  if v_moved is not null then
    raise exception '291: these payment_attempts rows changed during the apply: %', v_moved;
  end if;
  if (select count(*) from m291_before) <> (select count(*) from public.payment_attempts) then
    raise exception '291: the row count moved during the apply, which the lock above should make impossible; nothing was committed';
  end if;

  -- ── Still service-role only, as 174 left it: RLS on, no policy, nothing for the browser roles ──
  if not (select c.relrowsecurity from pg_catalog.pg_class c where c.oid = 'public.payment_attempts'::regclass) then
    raise exception '291: RLS is off on payment_attempts';
  end if;
  if exists (select 1 from pg_catalog.pg_policy p where p.polrelid = 'public.payment_attempts'::regclass) then
    raise exception '291: payment_attempts has a policy; it is meant to be service-role only (174)';
  end if;
  foreach v_col in array array['sent_fields', 'ecomind', 'avsresp', 'cvvresp'] loop
    foreach v_role in array array['anon', 'authenticated'] loop
      foreach v_priv in array array['SELECT', 'INSERT', 'UPDATE'] loop
        if has_column_privilege(v_role, 'public.payment_attempts', v_col, v_priv) then
          raise exception '291: % holds % on payment_attempts.%', v_role, v_priv, v_col;
        end if;
      end loop;
    end loop;
    foreach v_priv in array array['SELECT', 'INSERT', 'UPDATE'] loop
      if not has_column_privilege('service_role', 'public.payment_attempts', v_col, v_priv) then
        raise exception '291: service_role lacks % on payment_attempts.% — every charge would fall back to writing without it', v_priv, v_col;
      end if;
    end loop;
  end loop;

  raise notice '291: checks hold; 4 columns on payment_attempts, service-role only; % existing row(s) unchanged',
    (select count(*) from m291_before);
end
$check$;

notify pgrst, 'reload schema';

-- ── THE RECORD — the one thing `db query` prints ─────────────────────────────────────────
-- Before the commit, so a dry run (last `commit;` swapped for `rollback;`) prints the same row and
-- leaves nothing behind. Expected: columns 'avsresp text, cvvresp text, ecomind text, sent_fields
-- _text', rows_checked = the attempt count, rows_changed '(none)', rls true, policies 0.
-- Anything else: roll back (see ROLLBACK above) before recording the ledger row.
select
  '291' as migration,
  (select string_agg(c.column_name || ' ' || c.udt_name, ', ' order by c.column_name)
     from information_schema.columns c
    where c.table_schema = 'public' and c.table_name = 'payment_attempts'
      and c.column_name in ('sent_fields', 'ecomind', 'avsresp', 'cvvresp')) as columns,
  (select count(*) from m291_before)::int as rows_checked,
  coalesce((select string_agg(b.id::text, ', ' order by b.id)
         from m291_before b
         left join public.payment_attempts pa on pa.id = b.id
        where pa.id is null
           or exists (select 1 from jsonb_each(to_jsonb(pa)) e
                       where e.value is distinct from coalesce(b.snap -> e.key, 'null'::jsonb))), '(none)') as rows_changed,
  (select c.relrowsecurity from pg_catalog.pg_class c where c.oid = 'public.payment_attempts'::regclass) as rls,
  (select count(*) from pg_catalog.pg_policy p where p.polrelid = 'public.payment_attempts'::regclass)::int as policies;

commit;

-- After this: every card attempt from the new customer-pay and portal-payments records the field
-- names it sent and the ecomind, and keeps the AVS/CVV answer even when the card declines.
