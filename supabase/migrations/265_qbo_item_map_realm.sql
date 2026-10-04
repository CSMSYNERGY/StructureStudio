-- 265_qbo_item_map_realm.sql — which QuickBooks company each item mapping, and each invoice
--                              already pushed, belongs to. A company switch can then never bill
--                              a line as another company's item.
--
-- ⛔ APPLY BY HAND, AFTER A HUMAN HAS READ IT (SQL editor / MCP execute_sql /
--    `supabase db query --linked -f`), then record the row in
--    supabase_migrations.schema_migrations. NEVER `supabase db push`. The file carries its own
--    begin;/commit; so every assertion below takes the whole migration with it if it fails.
--
-- ── WHY ──────────────────────────────────────────────────────────────────────────────────
-- Bugs board card "QuickBooks disconnect/reconnect never tested" (Known bug, Medium). Carolyn,
-- 2026-09-08 (Fathom 815347282, 12:21): "this one should be fixed, you know, by this week." Two
-- faults, both because nothing recorded WHICH QuickBooks company a row was about:
--
--   1. Wrong-but-plausible invoices. QuickBooks item ids are per company. qbo-oauth-callback
--      cleared qbo_item_map only when client_settings.qbo_realm_id CHANGED, and two ordinary
--      paths leave a tenant with no realm on file while its map survives: another account taking
--      the company over (084's qbo_displace_realm nulls the realm and keeps the map on purpose)
--      and an operator clearing the realm by hand. Connecting a different company after either
--      read as a first connect, nothing was cleared, and every line billed as whatever item
--      happened to share the old id in the new books.
--   2. "Already in the books" for the wrong books. invoice_sends.qbo_invoice_id is all the push,
--      qbo_pending and retry_qbo_push look at, so after a switch an invoice that went to the OLD
--      company reads as pushed for the new one, with no way to tell.
--
-- The card's 09-02 question, never answered: "what should happen to invoices that were already
-- sent to the OLD one?" Default chosen: they stay recorded as pushed, to THAT company, which this
-- file now records. Nothing is re-pushed automatically; writing old invoices into a new
-- company's books is a bookkeeper's choice. retry_qbo_push says which company it is in.
--
-- ── SHAPE ────────────────────────────────────────────────────────────────────────────────
--   PART 1   qbo_item_map.realm_id, backfilled from the tenant's realm on file
--   PART 2   invoice_sends.qbo_realm_id, backfilled the same way for invoices already pushed
--   PART 3   apply-time assertions (they RAISE and abort the transaction)
-- No function, trigger, index or constraint changes. The unique indexes stay per (tenant, kind,
-- key[, style]) with no realm in them: one company's mapping per slot, which is the point.
--
-- ── HOW THE CODE USES IT (deployed after this file) ──────────────────────────────────────
--   _shared/qboRealm.ts     mapRowsForRealm: only rows whose realm_id equals the connected realm.
--                           NULL or another company's realm reads as NOT MAPPED, so the push
--                           stops with "unmapped: … then Retry" (loud) instead of a wrong item.
--   _shared/qboInvoice.ts   resolves lines from those rows only; stamps qbo_realm_id on the row
--                           when it creates or adopts the QuickBooks invoice. A mapping read
--                           that fails is reported as that, never as "unmapped".
--   qbo-oauth-callback      after the connection saves, deletes the tenant's rows stamped with
--                           another company. An unstamped row is stamped when the company just
--                           connected is the one already on file (PART 1's rule, applied at
--                           reconnect) and deleted otherwise. So a same-company reconnect deletes
--                           nothing; any other company clears the old rows.
--   portal-settings         save_item_map stamps the realm on file (and refuses a save with no
--                           company on file, or from a page loaded against another company: the
--                           companyTag list_item_map hands out), list_item_map and qbo_status
--                           count only that company's rows, qbo_status counts the invoices left
--                           in another company, retry_qbo_push answers otherCompany.
--
-- ── THE BACKFILL ─────────────────────────────────────────────────────────────────────────
-- A row is stamped with its tenant's CURRENT realm (the disconnect tombstone counts: it is the
-- company the tenant last connected). On 2026-10-04 that is exact, not a guess: one tenant is
-- connected, every mapping row and every pushed invoice in the project is its own, and every one
-- of those invoices was pushed after its current connection began (read-only checks that day).
-- A row whose tenant has no realm on file stays NULL. Nobody can say which company it named, and
-- NULL is read as "no company", so it can never bill against one. Rows already stamped are never
-- touched, so a re-apply changes nothing.
--
-- ── NUMBERING ────────────────────────────────────────────────────────────────────────────
-- Live ledger 2026-10-04: 261 is the newest. 262/263 are written on the email + call-recording
-- branch and 264 is the batch before this one, so this is 265 in the agreed batch order. Numbers
-- are confirmed against the live ledger at apply time:
-- `select version from supabase_migrations.schema_migrations order by 1 desc limit 3;` must not
-- already show 265.
--
-- ── WRITE ORDER: MAPPING CHORE, THEN THIS FILE, THEN portal-settings, THEN qbo-oauth-callback ──
-- * Any mapping saved through the Settings → QuickBooks grid AFTER this file but BEFORE the new
--   portal-settings is live is inserted by the old save_item_map with realm_id NULL, and the new
--   push reads that as not mapped. So do pending mapping work first, or re-run PART 1's UPDATE
--   right after portal-settings deploys (it only touches NULL rows of realm-holding tenants).
-- * The functions must not go live before this file: they select realm_id / qbo_realm_id, and
--   PostgREST answers a missing column with a 400. list_item_map would fail, the push's mapping
--   read would come back empty (every line "unmapped"), and every connect would land on
--   item_map_stale. portal-settings is the only importer of _shared/qboInvoice.ts.
-- * qbo-oauth-callback keeps verify_jwt = false (config.toml pins it; check after deploying).
--
-- ── SAFE WITH WHAT IS LIVE ───────────────────────────────────────────────────────────────
-- Beta and production share this database. Two nullable text columns with no default (a catalog
-- change, no table rewrite) that no live writer names, and two UPDATEs over a few dozen rows.
-- The live push selects named columns, so realm_id is invisible to it until it is redeployed; the
-- live save_item_map keeps working (see the write order for what it leaves NULL). Neither table
-- has a trigger. The apply waits at most 5 s for a lock (lock_timeout), so it gives up rather
-- than queue an invoice behind it; retry it.
--
-- ── GRANTS ───────────────────────────────────────────────────────────────────────────────
-- Both tables are service-role only: RLS on, no policy, nothing for the browser roles (066, 052,
-- 112). A new column carries no privilege of its own beyond the table's grants, so the browser
-- roles get nothing here; PART 3 checks it rather than assuming it. The realm id is not a secret
-- (qbo_status shows it masked), but nothing in the browser needs it either.
--
-- ── ROLLBACK ─────────────────────────────────────────────────────────────────────────────
-- ⚠️ Redeploy portal-settings and qbo-oauth-callback WITHOUT the 265 reads FIRST: with the columns
-- gone, every read naming them answers 400 (the same failure as deploying them too early).
-- Roll the two back TOGETHER, never portal-settings alone. A portal-settings without 265 saves
-- mappings with no realm; beside the 265 callback those are dropped by the next connect to a
-- different company (correct) and, while the realm on file is NULL, by any connect at all. And
-- portal-settings will carry later batches by then: "without 265" means reverting only this
-- change's hunks, not deploying an older tree.
-- Rolling forward again: re-run PART 1's UPDATE (it only stamps NULL rows of tenants with a realm
-- on file) before redeploying the callback and portal-settings.
-- STANDING CHECK for every later portal-settings deploy: grep the live copy and the candidate
-- bundle for `mapRowsForRealm`. If the live copy has it and the candidate does not, the candidate
-- was cut from a tree before 265 and would undo it: stop.
-- Dropping the columns forgets which company each mapping and invoice belongs to; the rows stay.
--   begin;
--   alter table public.qbo_item_map  drop column if exists realm_id;
--   alter table public.invoice_sends drop column if exists qbo_realm_id;
--   delete from supabase_migrations.schema_migrations where version = '265';
--   notify pgrst, 'reload schema';
--   commit;
-- ═════════════════════════════════════════════════════════════════════════════════════════

begin;

set local lock_timeout = '5s';

-- ═════════════════════════════════════════════════════════════════════════════════════════
-- PART 1 — qbo_item_map.realm_id: the company whose item each mapping names
-- ═════════════════════════════════════════════════════════════════════════════════════════
alter table public.qbo_item_map
  add column if not exists realm_id text;

comment on column public.qbo_item_map.realm_id is
  'The QuickBooks company (Intuit realm id) whose item qbo_item_id names. Item ids are per company, '
  'so only rows matching the connected company are read (_shared/qboRealm.ts) and qbo-oauth-callback '
  'deletes the rest on connect. NULL = unknown company, read as not mapped. Migration 265.';

update public.qbo_item_map m
   set realm_id = cs.qbo_realm_id
  from public.client_settings cs
 where cs.client_id = m.client_id
   and cs.qbo_realm_id is not null
   and m.realm_id is null;

-- ═════════════════════════════════════════════════════════════════════════════════════════
-- PART 2 — invoice_sends.qbo_realm_id: the company whose books hold the pushed invoice
-- ═════════════════════════════════════════════════════════════════════════════════════════
-- Only for invoices that reached QuickBooks (qbo_invoice_id set). One still waiting has no
-- company yet; the push stamps whichever company it lands in.
alter table public.invoice_sends
  add column if not exists qbo_realm_id text;

comment on column public.invoice_sends.qbo_realm_id is
  'The QuickBooks company (Intuit realm id) qbo_invoice_id lives in, stamped by the push. After a '
  'company switch an invoice stays recorded against the company it went to and is never re-pushed '
  'automatically; retry_qbo_push reports otherCompany. NULL with qbo_invoice_id set = pushed before '
  'migration 265 could say where. Migration 265.';

update public.invoice_sends i
   set qbo_realm_id = cs.qbo_realm_id
  from public.client_settings cs
 where cs.client_id = i.client_id
   and cs.qbo_realm_id is not null
   and i.qbo_invoice_id is not null
   and i.qbo_realm_id is null;

-- ═════════════════════════════════════════════════════════════════════════════════════════
-- PART 3 — apply-time assertions. Any RAISE aborts the whole migration.
-- ═════════════════════════════════════════════════════════════════════════════════════════
do $assert$
declare
  v_col   record;
  v_tbl   text;
  v_n     integer;
  v_role  text;
  v_priv  text;
begin
  -- ── The two columns: nullable text, no default ──
  for v_col in
    select t.tbl, t.col, c.data_type, c.is_nullable, c.column_default
      from (values ('qbo_item_map', 'realm_id'), ('invoice_sends', 'qbo_realm_id')) as t(tbl, col)
      left join information_schema.columns c
        on c.table_schema = 'public' and c.table_name = t.tbl and c.column_name = t.col
  loop
    if v_col.data_type is null then
      raise exception '265: %.% is missing', v_col.tbl, v_col.col;
    end if;
    if v_col.data_type <> 'text' or v_col.is_nullable <> 'YES' or v_col.column_default is not null then
      raise exception '265: %.% should be nullable text with no default, is % / nullable % / default %',
        v_col.tbl, v_col.col, v_col.data_type, v_col.is_nullable, v_col.column_default;
    end if;
  end loop;

  -- ── The backfill reached every row it could ──
  select count(*) into v_n
    from public.qbo_item_map m join public.client_settings cs on cs.client_id = m.client_id
   where cs.qbo_realm_id is not null and m.realm_id is null;
  if v_n > 0 then
    raise exception '265: % mapping row(s) of a tenant with a QuickBooks company on file are unstamped', v_n;
  end if;
  select count(*) into v_n
    from public.invoice_sends i join public.client_settings cs on cs.client_id = i.client_id
   where cs.qbo_realm_id is not null and i.qbo_invoice_id is not null and i.qbo_realm_id is null;
  if v_n > 0 then
    raise exception '265: % pushed invoice(s) of a tenant with a QuickBooks company on file are unstamped', v_n;
  end if;

  -- ── Still service-role only: RLS on, no policy, nothing for the browser roles ──
  foreach v_tbl in array array['qbo_item_map', 'invoice_sends'] loop
    if not (select c.relrowsecurity from pg_catalog.pg_class c
             where c.oid = ('public.' || v_tbl)::regclass) then
      raise exception '265: RLS is off on %', v_tbl;
    end if;
    if exists (select 1 from pg_catalog.pg_policy p where p.polrelid = ('public.' || v_tbl)::regclass) then
      raise exception '265: % has a policy; it is meant to be service-role only', v_tbl;
    end if;
  end loop;
  foreach v_role in array array['anon', 'authenticated'] loop
    foreach v_priv in array array['SELECT', 'INSERT', 'UPDATE'] loop
      if has_column_privilege(v_role, 'public.qbo_item_map', 'realm_id', v_priv) then
        raise exception '265: % holds % on qbo_item_map.realm_id', v_role, v_priv;
      end if;
      if has_column_privilege(v_role, 'public.invoice_sends', 'qbo_realm_id', v_priv) then
        raise exception '265: % holds % on invoice_sends.qbo_realm_id', v_role, v_priv;
      end if;
    end loop;
  end loop;

  -- ── The service role can do its job: the functions read and write both columns ──
  foreach v_priv in array array['SELECT', 'INSERT', 'UPDATE'] loop
    if not has_column_privilege('service_role', 'public.qbo_item_map', 'realm_id', v_priv) then
      raise exception '265: service_role lacks % on qbo_item_map.realm_id — mapping saves would fail', v_priv;
    end if;
  end loop;
  foreach v_priv in array array['SELECT', 'UPDATE'] loop
    if not has_column_privilege('service_role', 'public.invoice_sends', 'qbo_realm_id', v_priv) then
      raise exception '265: service_role lacks % on invoice_sends.qbo_realm_id — the push could not record its company', v_priv;
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
--      insert into supabase_migrations.schema_migrations (version, name) values ('265', '265_qbo_item_map_realm');
-- B. Every mapping and every pushed invoice of a connected tenant is stamped with that tenant's
--    company, and nothing else is (both counts 0):
--      select count(*) from public.qbo_item_map m join public.client_settings cs using (client_id)
--       where m.realm_id is distinct from cs.qbo_realm_id;
--      select count(*) from public.invoice_sends i join public.client_settings cs using (client_id)
--       where i.qbo_invoice_id is not null and i.qbo_realm_id is distinct from cs.qbo_realm_id;
--    and the totals (2026-10-04: 21 mapping rows, or 32 if the new-line-kinds mapping went first;
--    15 pushed invoices):
--      select count(*) total, count(realm_id) stamped from public.qbo_item_map;
--      select count(*) filter (where qbo_invoice_id is not null) pushed, count(qbo_realm_id) stamped from public.invoice_sends;
-- C. Deploy portal-settings, then qbo-oauth-callback (verify_jwt stays false). Then re-run B: a
--    mapping saved between A and C shows up there as a non-zero first count; re-run PART 1's
--    UPDATE to stamp it.
