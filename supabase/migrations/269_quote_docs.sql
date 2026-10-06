-- 269_quote_docs.sql — how many days a builder's quotes stay good for, printed on the formal
--                       estimate / quote PDF as "Valid until".
--
-- ⛔ APPLY BY HAND, AFTER A HUMAN HAS READ IT (SQL editor / MCP execute_sql /
--    `supabase db query --linked -f`), then record the row in
--    supabase_migrations.schema_migrations. NEVER `supabase db push`. The file carries its own
--    begin;/commit; so every assertion below takes the whole migration with it if it fails.
--
-- ── WHY ──────────────────────────────────────────────────────────────────────────────────
-- Carolyn, 2026-08-06 (Fathom 775681234, 1:00:07), on what the printed estimate should be: the
-- builder's letterhead and terms, the customer's name, and "estimate good for X amount of days".
-- Monday card "Generate two estimate PDFs: floor-plan summary + formal estimate". The formal
-- estimate PDF (_shared/estimatePdf.ts, 2026-08-10) already prints "Valid until", but always 30
-- days after the issue date; there was nowhere for a builder to say 14 or 60. This is that place.
-- The rest of batch B7 (the "Prepared for" / "Bill to" customer block and the logo) needs no schema.
--
-- ── SHAPE ────────────────────────────────────────────────────────────────────────────────
--   PART 1   client_settings.quote_valid_days integer NOT NULL DEFAULT 30, CHECK 1..365
--   PART 2   apply-time assertions (they RAISE and abort the transaction)
-- No function, trigger, index or policy changes. The default IS today's behaviour: every
-- existing tenant reads 30, so every quote prints the date it printed yesterday until a builder
-- changes the number in Settings → Company.
--
-- ── HOW THE CODE USES IT (deployed after this file) ──────────────────────────────────────
--   _shared/quoteValidity.ts  readQuoteValidDays: its own small read, never a column added to a
--                             caller's settings select, and tolerant: a missing column (a deploy
--                             ahead of this file) or any error reads 30. parseQuoteValidDays is the
--                             Settings save's rule (blank = 30, else a whole number 1..365).
--   submit-estimate           the CRM estimate's expiryDate, the SS quote PDF and the CRM-mode
--                             formal estimate PDF all use the tenant's number.
--   portal-settings           status returns quoteValidDays (null when the column cannot be read,
--                             which hides the Settings box); save takes quoteValidDays; every quote
--                             PDF it re-prints (regenerateQuotePdf) uses the number too.
--   portal (03-catalog.jsx)   Settings → Company: "Quotes are good for … days", beside Quote terms.
--
-- ── NUMBERING ────────────────────────────────────────────────────────────────────────────
-- Live ledger 2026-10-05: 261 is the newest. 262-265 are written on the integration branch and
-- 266-268 are held for the batches ahead of this one, so this is 269, the number assigned to
-- batch B7. Confirm against the live ledger at apply time:
-- `select version from supabase_migrations.schema_migrations order by 1 desc limit 3;` must not
-- already show 269.
--
-- ── WRITE ORDER: THIS FILE, THEN submit-estimate + portal-settings, THEN THE PORTAL ──────
-- Unlike most new columns, deploying the functions FIRST would not break anything: every read of
-- quote_valid_days is its own tolerant query (quoteValidity.ts), so a missing column prints 30 and
-- hides the Settings box. A Settings save sends quoteValidDays only when status could read it.
-- Apply this file first anyway: that is the plan, the tolerance is the seatbelt.
--
-- ── SAFE WITH WHAT IS LIVE ───────────────────────────────────────────────────────────────
-- Beta and production share this database. ADD COLUMN with a constant default is a catalog change
-- in Postgres 11+ (no table rewrite), on a table of a handful of rows (5 on 2026-10-05). The live
-- functions select named columns, so the new one is invisible to them; the live save upserts named
-- columns, so the NOT NULL default fills it on a first insert. client_settings has no trigger. The
-- apply waits at most 5 s for a lock (lock_timeout) and gives up rather than queue a quote behind
-- it; retry it.
--
-- ── GRANTS ───────────────────────────────────────────────────────────────────────────────
-- client_settings is service-role only: RLS on, no policy, nothing for the browser roles (it holds
-- the CRM API key). A new column carries no privilege beyond the table's grants, so the browser
-- roles get nothing here; PART 2 checks it rather than assuming it. The number is not a secret
-- (portal-settings status hands it to the Settings card), but the browser reads it only through
-- that function, like every other client_settings value.
--
-- ── ROLLBACK ─────────────────────────────────────────────────────────────────────────────
-- Safe in either order, because every reader is tolerant: with the column gone, quotes print 30
-- days again and the Settings box hides itself. A builder's chosen number is lost.
--   begin;
--   alter table public.client_settings drop column if exists quote_valid_days;
--   delete from supabase_migrations.schema_migrations where version = '269';
--   notify pgrst, 'reload schema';
--   commit;
-- ═════════════════════════════════════════════════════════════════════════════════════════

begin;

set local lock_timeout = '5s';

-- Was the column already here? Recorded for PART 2: on the first apply every tenant must read 30,
-- but a re-apply comes after builders have chosen their own numbers and must not refuse them.
select set_config('ss.m269_first_apply', (not exists (
  select 1 from information_schema.columns
   where table_schema = 'public' and table_name = 'client_settings' and column_name = 'quote_valid_days'
))::text, true);

-- ═════════════════════════════════════════════════════════════════════════════════════════
-- PART 1 — client_settings.quote_valid_days
-- ═════════════════════════════════════════════════════════════════════════════════════════
-- The constraint rides inside ADD COLUMN IF NOT EXISTS, so a re-apply skips both together and
-- never fails on "constraint already exists". 365 is the same ceiling the free-change window
-- uses (co_free_days): a quote held for more than a year is a price list, not a quote.
alter table public.client_settings
  add column if not exists quote_valid_days integer not null default 30
    constraint client_settings_quote_valid_days_range check (quote_valid_days between 1 and 365);

comment on column public.client_settings.quote_valid_days is
  'Days a quote stays good for: the formal estimate / quote PDF prints "Valid until" = issue date + '
  'this, and the CRM estimate''s expiry date uses it too. 1..365, default 30 (the fixed value before '
  'this column). Read through _shared/quoteValidity.ts, which treats a missing column as 30. '
  'Migration 269.';

-- ═════════════════════════════════════════════════════════════════════════════════════════
-- PART 2 — apply-time assertions. Any RAISE aborts the whole migration.
-- ═════════════════════════════════════════════════════════════════════════════════════════
do $assert$
declare
  v_col      record;
  v_n        integer;
  v_role     text;
  v_priv     text;
  v_refused  boolean;
begin
  -- ── The column: integer, NOT NULL, default 30 ──
  select c.data_type, c.is_nullable, c.column_default into v_col
    from information_schema.columns c
   where c.table_schema = 'public' and c.table_name = 'client_settings' and c.column_name = 'quote_valid_days';
  if v_col.data_type is null then
    raise exception '269: client_settings.quote_valid_days is missing';
  end if;
  if v_col.data_type <> 'integer' or v_col.is_nullable <> 'NO' or v_col.column_default is distinct from '30' then
    raise exception '269: client_settings.quote_valid_days should be integer NOT NULL DEFAULT 30, is % / nullable % / default %',
      v_col.data_type, v_col.is_nullable, v_col.column_default;
  end if;

  -- ── On the first apply, every existing tenant reads 30: nobody's printed date moved ──
  if current_setting('ss.m269_first_apply', true) = 'true' then
    select count(*) into v_n from public.client_settings where quote_valid_days is distinct from 30;
    if v_n > 0 then
      raise exception '269: % client_settings row(s) do not read 30 days right after the apply', v_n;
    end if;
  end if;

  -- ── The range holds at the database, not only in the Settings save ──
  -- Probed on the first row inside a sub-block, so the probe's own writes are rolled back with it
  -- and nothing about a real tenant changes. A table with no rows has nothing to probe; the
  -- constraint's definition is checked below either way.
  if exists (select 1 from public.client_settings) then
    foreach v_n in array array[0, 366, -1] loop
      v_refused := false;
      begin
        update public.client_settings set quote_valid_days = v_n
         where client_id = (select min(client_id) from public.client_settings);
      exception when check_violation then v_refused := true;
      end;
      if not v_refused then raise exception '269: quote_valid_days took % days', v_n; end if;
    end loop;
  end if;
  if not exists (
    select 1 from pg_catalog.pg_constraint
     where conrelid = 'public.client_settings'::regclass
       and conname = 'client_settings_quote_valid_days_range'
       and contype = 'c'
  ) then
    raise exception '269: the 1..365 check on quote_valid_days is missing';
  end if;

  -- ── Still service-role only: RLS on, no policy, nothing for the browser roles ──
  if not (select c.relrowsecurity from pg_catalog.pg_class c where c.oid = 'public.client_settings'::regclass) then
    raise exception '269: RLS is off on client_settings';
  end if;
  if exists (select 1 from pg_catalog.pg_policy p where p.polrelid = 'public.client_settings'::regclass) then
    raise exception '269: client_settings has a policy; it is meant to be service-role only';
  end if;
  foreach v_role in array array['anon', 'authenticated'] loop
    foreach v_priv in array array['SELECT', 'INSERT', 'UPDATE'] loop
      if has_column_privilege(v_role, 'public.client_settings', 'quote_valid_days', v_priv) then
        raise exception '269: % holds % on client_settings.quote_valid_days', v_role, v_priv;
      end if;
    end loop;
  end loop;

  -- ── The service role can do its job: the functions read it and the Settings save writes it ──
  foreach v_priv in array array['SELECT', 'INSERT', 'UPDATE'] loop
    if not has_column_privilege('service_role', 'public.client_settings', 'quote_valid_days', v_priv) then
      raise exception '269: service_role lacks % on client_settings.quote_valid_days — the Settings save would fail', v_priv;
    end if;
  end loop;
end
$assert$;

notify pgrst, 'reload schema';

commit;

-- ═════════════════════════════════════════════════════════════════════════════════════════
-- AFTER APPLYING
-- ═════════════════════════════════════════════════════════════════════════════════════════
-- A. Record it:
--      insert into supabase_migrations.schema_migrations (version, name) values ('269', '269_quote_docs');
-- B. Every tenant reads 30 (2026-10-05: 5 rows):
--      select quote_valid_days, count(*) from public.client_settings group by 1;
-- C. Deploy submit-estimate and portal-settings (the only importers of _shared/estimatePdf.ts,
--    _shared/quotePdf.ts, _shared/pdfLogo.ts and _shared/quoteValidity.ts), then grep both
--    downloaded live copies for "readQuoteValidDays" and "pdfLogoSources".
