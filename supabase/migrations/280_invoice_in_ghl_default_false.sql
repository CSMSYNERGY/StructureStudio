-- 280_invoice_in_ghl_default_false.sql — a builder whose settings row is created from now on starts
-- on StructureStudio's own quotes and invoices, not on GoHighLevel's.
--
-- ⛔ APPLY BY HAND, AFTER A HUMAN HAS READ IT. Pipe this file to `supabase db query --linked`
--    (stdin; see 270's header for why not `--file` or an inline "$(cat …)"), then record it:
--      insert into supabase_migrations.schema_migrations (version, name) values ('280', '280_invoice_in_ghl_default_false') returning version;
--    NEVER `supabase db push`. The file carries its own begin;/commit;, so a failed check anywhere
--    takes the whole migration with it. `db query` prints no NOTICE, only the last statement's rows:
--    THE RECORD at the end is what the apply shows. No row printed means the file did not run. To
--    see the same row and change nothing, pipe it with the last `commit;` swapped for `rollback;`.
--
-- ── WHY ──────────────────────────────────────────────────────────────────────────────────
-- Carolyn, 2026-09-07 (quoted in 217's header): "All other builders will only have the option to
-- invoice through SS." 217 made invoicing THROUGH the CRM a capability (ghl_invoicing_allowed,
-- default false, one tenant holds it) and the Settings screen now offers nobody else that choice.
-- But it left 121's column default alone, so every client_settings row created since still starts
-- with invoice_in_ghl = TRUE: a mode the tenant cannot pick, and cannot see a switch for.
--
-- What that costs a new builder today. Their row appears on the first save that touches it — a
-- Business Details save, a CRM connection, or create_client's billing-exempt or discount upsert:
--   * with no CRM connected, submit-estimate (its step 1) reads "CRM mode, no CRM" and turns every
--     quote away with "isn't set up to send quotes yet ... connect your CRM, or switch quotes to
--     Structure Studio paperwork". The second half names a switch the screen no longer shows;
--   * with a CRM connected, every quote goes out as a GoHighLevel estimate: the very route 217 took
--     away from everyone but one builder, reached by connecting a CRM before anything else.
-- With the row starting false, both are in paperwork mode with no numbering yet, and the answer is
-- 9-ALT's refusal instead: "no starting quote number set. Add one in Settings → CRM Connection →
-- Quotes & Invoices", which is the exact place the fix lives.
--
-- 121's header called DEFAULT TRUE "the whole safety story", and on the day it applied it was: it
-- kept every EXISTING tenant on the path they were selling through. That job is done — those rows
-- exist and keep their value (below). For a row that does not exist yet, true protects nobody.
--
-- ── WHAT THIS DOES ───────────────────────────────────────────────────────────────────────
--   * One catalog change: the column's DEFAULT. No row is updated. Measured live 2026-10-05:
--     5 rows, 4 still true (1 of them with the capability, 3 without), 1 false. Every one keeps its
--     value; each grandfathered tenant moves on its own Quotes & Invoices save, with a starting
--     quote number, a starting invoice number and a tax rate that only the builder can give
--     (portal-settings refuses that save without all three, and 217's rule stands: never invent
--     numbering that could repeat a number a customer already holds).
--   * A NEW row starts false. Until its owner saves the Quotes & Invoices card, that is paperwork
--     mode with no numbering, which is a refusal and never a document: submit-estimate's 9-ALT
--     allocates nothing from a NULL ss_quote_next and answers with the sentence above.
--     (9-ALT's comment calls this combination "edited around the portal"; after 280 a first
--     non-invoicing save reaches it legitimately. The refusal is the right answer either way.)
--   * A new paperwork-mode tenant without its own verified domain sends its customer email from
--     the platform address (_shared/emailSend.ts, `paperworkMode`), as every paperwork-mode tenant
--     already does. A CRM-mode row would have stayed dark there until a domain verified.
--
-- ── WHAT THIS DOES NOT DO ────────────────────────────────────────────────────────────────
--   * NO READ-TIME OVERRIDE. Every reader keeps `invoice_in_ghl !== false` (anything but an explicit
--     false is the CRM), and nothing starts treating "not allowed" as false. A CRM-connected builder
--     still on the CRM path would otherwise flip mid-flight into paperwork mode with no numbering,
--     and every quote they send would become a refusal.
--   * Does not touch ghl_invoicing_allowed, any tenant's numbering or tax rate, or the CRM
--     connection (contacts and opportunities keep flowing to a connected CRM in both modes).
--   * Does not create a row for a tenant that has none. Their first save creates it.
--   * No page and no reader behaves differently with it. One check in portal-settings changes
--     with it (batch B1): the save's two merged-state checks (the change order fee, and the three
--     Quotes & Invoices values) used to read a tenant with NO row as CRM mode. The save they guard
--     creates that row, and under this file it starts false, so they now judge it as paperwork.
--     Before, a lone starting quote number from a tenant with no row skipped all three refusals
--     and landed a paperwork-mode row with no invoice number and no rate.
--
-- ── SAFE WITH WHAT IS LIVE ───────────────────────────────────────────────────────────────
-- Beta and production share this database, so the new default is live for both the moment this
-- commits; neither frontend reads the default. ALTER COLUMN ... SET DEFAULT is a catalog change
-- (no rewrite, no scan) that takes a brief ACCESS EXCLUSIVE lock on client_settings, which every
-- quote and every Settings read touches, so lock_timeout makes a hung apply give up instead. The
-- table has no trigger. Every live writer upserts NAMED columns, and INSERT ... ON CONFLICT DO
-- UPDATE sets only the columns it names, so an existing row never picks up the new default
-- (tests/sql/migration280.test.cjs drives that as portal-settings sends it).
--
-- ── NUMBERING ────────────────────────────────────────────────────────────────────────────
-- Live ledger 2026-10-06: 278 (partition walls) is the newest; 279 was never written. 280 is held
-- for batch B1 (this file; if B1 needs more schema it goes in here) and 281 for B3. Confirm at apply
-- time, and record the ledger row with `returning`: no row back means 280 was taken, so rename.
--   select version from supabase_migrations.schema_migrations order by 1 desc limit 3;
--
-- ── ORDER ────────────────────────────────────────────────────────────────────────────────
-- This file FIRST, then batch B1's portal-settings deploy (its save checks assume a new row starts
-- false; deployed ahead of this file, a tenant with no row could save a change order fee into a row
-- created on the CRM path, where it charges nothing). Then, per tenant and only once the builder has
-- given their numbers, the Quotes & Invoices save (owner, or an operator viewing as them). Never
-- write those values by hand.
--
-- ── ROLLBACK ─────────────────────────────────────────────────────────────────────────────
--   alter table public.client_settings alter column invoice_in_ghl set default true;
--   comment on column public.client_settings.invoice_in_ghl is
--     'true (default) = quotes/invoices are GHL objects, today''s path. false = StructureStudio issues them; contacts + opportunities still go to GHL.';
--   delete from supabase_migrations.schema_migrations where version = '280';
-- Rows created while 280 was live keep false. Each is a tenant that had no numbering yet: its
-- Quotes & Invoices save is still the way forward, and nothing has to be flipped back.

begin;

-- The ALTER takes ACCESS EXCLUSIVE on client_settings (brief: a catalog change). A hung apply must
-- give up rather than sit in front of every quote's settings read.
set local lock_timeout = '5s';

-- Every row BEFORE anything here runs, so the checks can prove the default moved and no row did.
create temp table m280_before on commit drop as
  select client_id, invoice_in_ghl, ghl_invoicing_allowed, ss_quote_next, ss_invoice_next, ss_tax_rate
    from public.client_settings;

-- ── THE CHANGE ───────────────────────────────────────────────────────────────────────────
alter table public.client_settings
  alter column invoice_in_ghl set default false;

comment on column public.client_settings.invoice_in_ghl is
  'Who issues this tenant''s quotes and invoices. false (the default since migration 280) = '
  'StructureStudio, numbered from ss_quote_next / ss_invoice_next and taxed at ss_tax_rate; contacts '
  'and opportunities still go to a connected CRM. true = they are GoHighLevel objects, which only a '
  'tenant with ghl_invoicing_allowed (217) can choose. Read as "anything but false is the CRM", so a '
  'row written before 280 keeps the path it had.';

-- ── CHECKS: raise (and so roll the whole file back) rather than commit a surprise ───────
do $check$
declare
  v_col    record;
  v_moved  text;
  v_role   text;
  v_priv   text;
  v_probe  constant text := '__m280_rehearsal__';
  v_new    boolean;
  v_newcap boolean;
begin
  -- ── The column: boolean, NOT NULL, default false ──
  select c.data_type, c.is_nullable, c.column_default into v_col
    from information_schema.columns c
   where c.table_schema = 'public' and c.table_name = 'client_settings' and c.column_name = 'invoice_in_ghl';
  if v_col.data_type is null then
    raise exception '280: client_settings.invoice_in_ghl is missing (migration 121 not applied?)';
  end if;
  if v_col.data_type <> 'boolean' or v_col.is_nullable <> 'NO' or v_col.column_default is distinct from 'false' then
    raise exception '280: client_settings.invoice_in_ghl should be boolean NOT NULL DEFAULT false, is % / nullable % / default %',
      v_col.data_type, v_col.is_nullable, v_col.column_default;
  end if;

  -- ── No existing row moved: mode, capability, numbering and rate all exactly as they were ──
  select string_agg(b.client_id, ', ' order by b.client_id) into v_moved
    from m280_before b
    left join public.client_settings cs on cs.client_id = b.client_id
   where cs.client_id is null
      or (cs.invoice_in_ghl, cs.ghl_invoicing_allowed, cs.ss_quote_next, cs.ss_invoice_next, cs.ss_tax_rate)
         is distinct from (b.invoice_in_ghl, b.ghl_invoicing_allowed, b.ss_quote_next, b.ss_invoice_next, b.ss_tax_rate);
  if v_moved is not null then
    raise exception '280: these client_settings rows changed during the apply: %', v_moved;
  end if;
  if (select count(*) from m280_before) <> (select count(*) from public.client_settings) then
    raise exception '280: the row count moved during the apply — run it again';
  end if;

  -- ── Still service-role only: RLS on, no policy, nothing for the browser roles ──
  if not (select c.relrowsecurity from pg_catalog.pg_class c where c.oid = 'public.client_settings'::regclass) then
    raise exception '280: RLS is off on client_settings';
  end if;
  if exists (select 1 from pg_catalog.pg_policy p where p.polrelid = 'public.client_settings'::regclass) then
    raise exception '280: client_settings has a policy; it is meant to be service-role only';
  end if;
  foreach v_role in array array['anon', 'authenticated'] loop
    foreach v_priv in array array['SELECT', 'INSERT', 'UPDATE'] loop
      if has_column_privilege(v_role, 'public.client_settings', 'invoice_in_ghl', v_priv) then
        raise exception '280: % holds % on client_settings.invoice_in_ghl', v_role, v_priv;
      end if;
    end loop;
  end loop;
  foreach v_priv in array array['SELECT', 'INSERT', 'UPDATE'] loop
    if not has_column_privilege('service_role', 'public.client_settings', 'invoice_in_ghl', v_priv) then
      raise exception '280: service_role lacks % on client_settings.invoice_in_ghl — the Quotes & Invoices save would fail', v_priv;
    end if;
  end loop;

  -- ── The rehearsal: a brand-new row, the way a first save creates one, and roll it back ──
  -- A sub-block whose own exception is its rollback: the insert is undone and only the two answers
  -- (plain variables) survive it. Only client_id is named, so every other column takes its default.
  if exists (select 1 from public.client_settings where client_id = v_probe) then
    raise exception '280: a client_settings row named % already exists; the rehearsal will not touch it', v_probe;
  end if;
  begin
    insert into public.client_settings (client_id) values (v_probe)
      returning invoice_in_ghl, ghl_invoicing_allowed into v_new, v_newcap;
    raise exception using errcode = 'S2800', message = '280: rehearsal rolled back';
  exception when sqlstate 'S2800' then
    null;
  end;
  if v_new is distinct from false then
    raise exception '280: a new client_settings row starts with invoice_in_ghl = %, expected false', coalesce(v_new::text, 'null');
  end if;
  if v_newcap is distinct from false then
    raise exception '280: a new client_settings row starts with ghl_invoicing_allowed = %, expected false (217)', coalesce(v_newcap::text, 'null');
  end if;
  if exists (select 1 from public.client_settings where client_id = v_probe) then
    raise exception '280: the rehearsal row % was not rolled back', v_probe;
  end if;
  perform set_config('ss.m280_new_row', v_new::text, true);

  raise notice '280: checks hold; invoice_in_ghl defaults to false; % existing row(s) unchanged',
    (select count(*) from m280_before);
end
$check$;

notify pgrst, 'reload schema';

-- ── THE RECORD — the one thing `db query` prints ─────────────────────────────────────────
-- Before the commit, so a dry run (last `commit;` swapped for `rollback;`) prints the same row and
-- leaves nothing behind. Expected on 2026-10-05:
--   invoice_in_ghl_default 'false', rows_checked 5, rows_changed '(none)', crm_invoicing 4,
--   grandfathered 3 (CRM mode without the capability: each moves on its own save), new_row_starts 'false'
-- Anything else: roll back (see ROLLBACK above) before recording the ledger row.
select
  '280' as migration,
  (select c.column_default from information_schema.columns c
    where c.table_schema = 'public' and c.table_name = 'client_settings' and c.column_name = 'invoice_in_ghl') as invoice_in_ghl_default,
  (select count(*) from m280_before)::int as rows_checked,
  coalesce((select string_agg(b.client_id, ', ' order by b.client_id)
              from m280_before b join public.client_settings cs on cs.client_id = b.client_id
             where cs.invoice_in_ghl is distinct from b.invoice_in_ghl), '(none)') as rows_changed,
  (select count(*) from public.client_settings where invoice_in_ghl)::int as crm_invoicing,
  (select count(*) from public.client_settings where invoice_in_ghl and not ghl_invoicing_allowed)::int as grandfathered,
  current_setting('ss.m280_new_row', true) as new_row_starts;

commit;

-- After this: every existing builder invoices exactly as before, and a builder whose settings row is
-- created from now on starts on StructureStudio paperwork, asked for its numbering before its first quote.
