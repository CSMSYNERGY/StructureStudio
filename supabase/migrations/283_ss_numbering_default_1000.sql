-- 283_ss_numbering_default_1000.sql — a builder who hasn't set a starting quote or invoice number starts
-- at 1000, instead of being refused.
--
-- ⛔ APPLY BY HAND, AFTER A HUMAN HAS READ IT. Pipe this file to `supabase db query --linked`
--    (stdin; see 270's header for why not `--file` or an inline "$(cat …)"), then record it:
--      insert into supabase_migrations.schema_migrations (version, name) values ('283', '283_ss_numbering_default_1000') returning version;
--    NEVER `supabase db push`. The file carries its own begin;/commit;, so a failed check anywhere
--    takes the whole migration with it. `db query` prints no NOTICE, only the last statement's rows:
--    THE RECORD at the end is what the apply shows. No row printed means the file did not run. To
--    see the same row and change nothing, pipe it with the last `commit;` swapped for `rollback;`.
--
-- ── WHY ──────────────────────────────────────────────────────────────────────────────────
-- Carolyn, 2026-10-06 (relayed by Ahsan): "if a builder hasn't set a starting number, start at 1000
-- automatically (quotes and invoices)." For the blank case, that answer replaces the rule 121, 217 and
-- 280 wrote down: never invent numbering, refuse until the builder gives a number. Those files are
-- applied and stay exactly as they are; this one changes what a blank means from here on.
--
-- What the old rule cost. A builder on StructureStudio paperwork with no starting number gets no quote
-- out at all: submit-estimate's 9-ALT asks allocate_ss_quote_number (123) for a number, gets NULL back
-- for a NULL ss_quote_next, and turns the shopper away. The Quotes & Invoices card would not save
-- without both numbers either, so a builder with no numbering of their own (new, or never kept any
-- outside a CRM) had to make one up before their first customer could get a quote.
--
-- ── WHAT THIS DOES ───────────────────────────────────────────────────────────────────────
--   * Re-issues both allocators: same signature, SECURITY DEFINER, search_path public, service-role
--     only (the revokes are re-asserted below; CREATE OR REPLACE keeps service_role's grant).
--   * A SET counter is used exactly as before. The number handed out is the counter, prefix included,
--     and the counter goes up by one. No floor is applied to it: portal-settings' save still refuses a
--     typed start at or below a number already issued, and that check owns the set case.
--   * A NULL counter now means "start at 1000". The first allocation hands out 1000 and stores 1001.
--     The exception is a builder who already issued numbers under the CURRENT prefix (they cleared the
--     field after using it): numbering continues one past the highest of those, the number the save's
--     floor check would have made them type. A new prefix has issued nothing, so it restarts at 1000.
--     Numbers under another prefix, tails that aren't plain digits, and invoice rows the CRM issued
--     (invoice_sends.issued_by = 'ghl', a different book) never count.
--   * The settings row is locked (SELECT ... FOR UPDATE) BEFORE the floor is read, so the read and the
--     bump are one decision. A second caller arriving in the same moment waits on the lock, then finds
--     the counter the first one stored and never reads the floor at all.
--   * No row is written and no default changes. NULL stays in the table as "not chosen", so the card
--     can still show a blank field; the allocator fills it in on first use.
--   * A tenant with NO client_settings row still gets NULL back. submit-estimate refuses those before
--     it ever asks ("hasn't finished setting up quotes yet"), and that stays as it is.
--
-- ── WHAT THIS DOES NOT DO ────────────────────────────────────────────────────────────────
--   * No read-time override (280's stance holds). A CRM-mode row (invoice_in_ghl true) never calls the
--     allocators, and nothing here moves a builder between modes.
--   * Does not touch any tenant's numbers, prefixes, tax rate or mode. Measured live 2026-10-07: 5 rows,
--     1 on StructureStudio paperwork, and that one has both counters set, so the new default reaches
--     nobody on the day it applies (THE RECORD's paperwork_rows_with_null_counter).
--   * Does not change order numbers (163's orders_assign_no already starts an unset tenant at 1001),
--     change orders (CO-n per order, 126) or shop serials (075). Carolyn named quotes and invoices.
--   * Does not make a tax rate optional. A paperwork tenant without one is still refused, now BEFORE a
--     number is taken (submit-estimate, same batch).
--
-- ── SAFE WITH WHAT IS LIVE / ORDER ───────────────────────────────────────────────────────
-- Beta and production share this database, so both see the new allocators the moment this commits.
--   1. submit-estimate FIRST. Its 9-ALT now allocates the quote number AFTER the sales-tax decision, so a
--      quote refused for want of a tax rate burns no number. Behind this file instead, every refused
--      shopper attempt at an unconfigured paperwork tenant would take 1000, then 1001, and so on.
--      Deploy it from a tree that holds every merged sibling (another batch's submit-estimate deploy
--      from a tree without this reorder would silently put the allocation back in front).
--   2. This file. IMMEDIATELY BEFORE applying it, download the live submit-estimate again and grep it
--      for "The quote number (moved below the tax decision". No match means a later deploy reverted
--      the reorder: redeploy step 1 first, never apply over it.
--   3. portal-settings (it bundles _shared/qboInvoice.ts, which now adopts an existing QuickBooks
--      DocNumber only for the same customer): its save stops demanding the two numbers, keeps a
--      counter already in use over a blank box, and send_invoice / push_to_invoice ask a QuickBooks-
--      connected builder for their next number. Ahead of this file, a blank save would store a NULL
--      that 123's allocator turns straight back into a refusal.
--   4. The portal card (beta on push, production on promotion). Until then production's card still asks
--      for both numbers, which is stricter than the server and harmless.
-- CREATE OR REPLACE swaps the function bodies in place: a quote or invoice mid-allocation finishes on
-- the old body, the next one runs the new. The rehearsal below takes row locks on a probe tenant only.
--
-- ── NUMBERING ────────────────────────────────────────────────────────────────────────────
-- Live ledger 2026-10-07: 282 is the newest; 281 is written but held unapplied. 283 is this file.
-- Confirm at apply time, and record the ledger row with `returning`: no row back means 283 was taken,
-- so rename.
--   select version from supabase_migrations.schema_migrations order by 1 desc limit 3;
--
-- ── ROLLBACK ─────────────────────────────────────────────────────────────────────────────
--   begin;
--   create or replace function public.allocate_ss_quote_number(p_client_id text)
--   returns text
--   language plpgsql
--   security definer
--   set search_path to 'public'
--   as $fn$
--   declare
--     v_used   integer;
--     v_prefix text;
--   begin
--     update public.client_settings
--        set ss_quote_next = ss_quote_next + 1,
--            updated_at    = now()
--      where client_id = p_client_id
--        and ss_quote_next is not null
--     returning ss_quote_next - 1, coalesce(ss_quote_prefix, '')
--          into v_used, v_prefix;
--
--     if v_used is null then
--       return null;   -- no row, or no starting number set
--     end if;
--
--     return v_prefix || v_used::text;
--   end;
--   $fn$;
--
--   revoke execute on function public.allocate_ss_quote_number(text) from public;
--   revoke execute on function public.allocate_ss_quote_number(text) from anon;
--   revoke execute on function public.allocate_ss_quote_number(text) from authenticated;
--
--   create or replace function public.allocate_ss_invoice_number(p_client_id text)
--   returns text
--   language plpgsql
--   security definer
--   set search_path to 'public'
--   as $fn$
--   declare
--     v_used   integer;
--     v_prefix text;
--   begin
--     update public.client_settings
--        set ss_invoice_next = ss_invoice_next + 1,
--            updated_at      = now()
--      where client_id = p_client_id
--        and ss_invoice_next is not null
--     returning ss_invoice_next - 1, coalesce(ss_invoice_prefix, '')
--          into v_used, v_prefix;
--
--     if v_used is null then
--       return null;   -- no row, or no starting number set
--     end if;
--
--     return v_prefix || v_used::text;
--   end;
--   $fn$;
--
--   revoke execute on function public.allocate_ss_invoice_number(text) from public;
--   revoke execute on function public.allocate_ss_invoice_number(text) from anon;
--   revoke execute on function public.allocate_ss_invoice_number(text) from authenticated;
--
--   delete from supabase_migrations.schema_migrations where version = '283';
--   commit;
-- Those are 123's and 125's statements exactly as the files wrote them. (The bodies live before 283 are
-- the same code minus the trailing "-- no row, or no starting number set" comment, which the original
-- apply dropped; behaviour is identical.) In this order:
--   a. Redeploy portal-settings from origin/beta as it was before this batch (its save asks for both
--      numbers again), so no new blank lands while the old allocators are coming back. The
--      submit-estimate reorder can stay: it is correct under either allocator.
--   b. List the rows a rollback would strand. A tenant that took a number while 283 was live has a
--      counter now and keeps it, but one that SAVED a blank start and has issued nothing yet would be
--      refused on its next quote or invoice (123/125 answer NULL for a NULL counter), with no word to
--      the builder:
--        select client_id, ss_quote_next, ss_invoice_next from public.client_settings
--         where invoice_in_ghl = false and (ss_quote_next is null or ss_invoice_next is null);
--      Resolve each one first: ask the builder for their numbers, or set explicit starts the way 283's
--      allocator would have (1000, or one past the highest issued under the current prefix).
--   c. Run the block above.

begin;

-- The rehearsal below inserts a probe tenant's settings row, designs and invoice rows and takes their
-- row locks. A hung apply must give up rather than sit in front of anything a builder is waiting on.
set local lock_timeout = '5s';

-- Every row's numbering BEFORE anything here runs, so the checks can prove no row moved.
create temp table m283_before on commit drop as
  select client_id, invoice_in_ghl, ss_quote_next, ss_quote_prefix, ss_invoice_next, ss_invoice_prefix
    from public.client_settings;

-- ── THE CHANGE (1 of 2): quote numbers ───────────────────────────────────────────────────
create or replace function public.allocate_ss_quote_number(p_client_id text)
returns text
language plpgsql
security definer
set search_path to 'public'
as $fn$
declare
  v_next   integer;
  v_prefix text;
  v_start  integer;
  v_used   integer;
begin
  -- The row lock FIRST (see the header). Two first quotes in the same second both see a NULL
  -- counter; the second waits here, then reads the counter the first one stored.
  select ss_quote_next, coalesce(ss_quote_prefix, '')
    into v_next, v_prefix
    from public.client_settings
   where client_id = p_client_id
     for update;
  if not found then
    return null;   -- no row: the tenant has not set up quotes at all
  end if;

  -- Not chosen (NULL): 1000, or one past the highest quote already issued under THIS prefix.
  -- Plain digits only, nine at most, so a hand-typed tail can neither break the cast nor overflow
  -- the integer counter. A set counter never reads this.
  if v_next is null then
    select greatest(1000, coalesce(max(
             case when substr(d.ss_quote_number, length(v_prefix) + 1) ~ '^[0-9]{1,9}$'
                  then substr(d.ss_quote_number, length(v_prefix) + 1)::bigint end), 0) + 1)::integer
      into v_start
      from public.designs d
     where d.client_id = p_client_id
       and d.ss_quote_number is not null
       and starts_with(d.ss_quote_number, v_prefix);
  end if;

  -- Pre-increment, as 123 did: hand back what was taken. coalesce keeps a set counter exactly as
  -- it was; v_start only ever fills a NULL.
  update public.client_settings
     set ss_quote_next = coalesce(ss_quote_next, v_start) + 1,
         updated_at    = now()
   where client_id = p_client_id
  returning ss_quote_next - 1 into v_used;

  return v_prefix || v_used::text;
end;
$fn$;

revoke execute on function public.allocate_ss_quote_number(text) from public;
revoke execute on function public.allocate_ss_quote_number(text) from anon;
revoke execute on function public.allocate_ss_quote_number(text) from authenticated;

-- ── THE CHANGE (2 of 2): invoice numbers ─────────────────────────────────────────────────
-- The quote allocator over the invoice pair (125's mirror). Its floor reads OUR invoices only: a
-- GHL-converted row carries that CRM's number, which is a different book entirely.
create or replace function public.allocate_ss_invoice_number(p_client_id text)
returns text
language plpgsql
security definer
set search_path to 'public'
as $fn$
declare
  v_next   integer;
  v_prefix text;
  v_start  integer;
  v_used   integer;
begin
  select ss_invoice_next, coalesce(ss_invoice_prefix, '')
    into v_next, v_prefix
    from public.client_settings
   where client_id = p_client_id
     for update;
  if not found then
    return null;   -- no row: the tenant has not set up invoices at all
  end if;

  if v_next is null then
    select greatest(1000, coalesce(max(
             case when substr(s.invoice_number, length(v_prefix) + 1) ~ '^[0-9]{1,9}$'
                  then substr(s.invoice_number, length(v_prefix) + 1)::bigint end), 0) + 1)::integer
      into v_start
      from public.invoice_sends s
     where s.client_id = p_client_id
       and s.issued_by = 'structurestudio'
       and s.invoice_number is not null
       and starts_with(s.invoice_number, v_prefix);
  end if;

  update public.client_settings
     set ss_invoice_next = coalesce(ss_invoice_next, v_start) + 1,
         updated_at      = now()
   where client_id = p_client_id
  returning ss_invoice_next - 1 into v_used;

  return v_prefix || v_used::text;
end;
$fn$;

revoke execute on function public.allocate_ss_invoice_number(text) from public;
revoke execute on function public.allocate_ss_invoice_number(text) from anon;
revoke execute on function public.allocate_ss_invoice_number(text) from authenticated;

-- ── CHECKS: raise (and so roll the whole file back) rather than commit a surprise ───────
do $check$
declare
  v_fn       text;
  v_oid      regprocedure;
  v_src      text;
  v_lock     integer;
  v_floor    integer;
  v_role     text;
  v_moved    text;
  v_probe    constant text := '__m283_rehearsal__';
  v_none     constant text := '__m283_no_row__';
  v_norow_q  text := 'unset';
  v_norow_i  text := 'unset';
  v_q        text[] := '{}';
  v_i        text[] := '{}';
  v_qnext    integer;
  v_inext    integer;
  i          integer;
begin
  -- ── Both allocators: the shape every caller relies on ──
  foreach v_fn in array array['allocate_ss_quote_number', 'allocate_ss_invoice_number'] loop
    v_oid := to_regprocedure('public.' || v_fn || '(text)');
    if v_oid is null then
      raise exception '283: public.%(text) is missing', v_fn;
    end if;
    if not (select p.prosecdef from pg_catalog.pg_proc p where p.oid = v_oid) then
      raise exception '283: % is not SECURITY DEFINER; client_settings is service-role only, so it could not read the row', v_fn;
    end if;
    if (select p.proconfig from pg_catalog.pg_proc p where p.oid = v_oid) is distinct from array['search_path=public'] then
      raise exception '283: % should run with search_path=public, runs with %', v_fn,
        coalesce((select p.proconfig::text from pg_catalog.pg_proc p where p.oid = v_oid), 'none');
    end if;
    if (select p.prorettype from pg_catalog.pg_proc p where p.oid = v_oid) <> 'text'::regtype then
      raise exception '283: % no longer returns text', v_fn;
    end if;
    -- A function that mints document numbers is never the public internet's to call.
    foreach v_role in array array['anon', 'authenticated'] loop
      if has_function_privilege(v_role, v_oid, 'EXECUTE') then
        raise exception '283: % can execute %', v_role, v_fn;
      end if;
    end loop;
    if not has_function_privilege('service_role', v_oid, 'EXECUTE') then
      raise exception '283: service_role cannot execute % — every quote or invoice would fail', v_fn;
    end if;
    -- The lock comes before the floor read. PGlite runs one connection, so no test can race two
    -- first allocations; this is the tripwire that keeps the lock where the header says it is.
    select lower(p.prosrc) into v_src from pg_catalog.pg_proc p where p.oid = v_oid;
    v_lock := position('for update' in v_src);
    v_floor := position(case v_fn when 'allocate_ss_quote_number' then 'from public.designs' else 'from public.invoice_sends' end in v_src);
    if v_lock = 0 or v_floor = 0 or v_lock > v_floor then
      raise exception '283: % must lock the settings row (for update) before it reads the floor', v_fn;
    end if;
  end loop;

  -- ── No existing row moved: mode, numbers and prefixes all exactly as they were ──
  select string_agg(b.client_id, ', ' order by b.client_id) into v_moved
    from m283_before b
    left join public.client_settings cs on cs.client_id = b.client_id
   where cs.client_id is null
      or (cs.invoice_in_ghl, cs.ss_quote_next, cs.ss_quote_prefix, cs.ss_invoice_next, cs.ss_invoice_prefix)
         is distinct from (b.invoice_in_ghl, b.ss_quote_next, b.ss_quote_prefix, b.ss_invoice_next, b.ss_invoice_prefix);
  if v_moved is not null then
    raise exception '283: these client_settings rows changed during the apply (a quote or invoice issued meanwhile?): % — run it again', v_moved;
  end if;
  if (select count(*) from m283_before) <> (select count(*) from public.client_settings) then
    raise exception '283: the row count moved during the apply — run it again';
  end if;

  -- ── The rehearsal: a probe tenant, both books, then rolled back ──
  -- A sub-block whose own exception is its rollback: every insert and every bump is undone, and only
  -- the answers (plain variables) survive it.
  if exists (select 1 from public.client_settings where client_id in (v_probe, v_none)) then
    raise exception '283: a client_settings row named % or % already exists; the rehearsal will not touch it', v_probe, v_none;
  end if;
  if exists (select 1 from public.designs where client_id = v_probe or short_code like '\_\_m283\_%')
     or exists (select 1 from public.invoice_sends where client_id = v_probe) then
    raise exception '283: rows for the rehearsal tenant % already exist; the rehearsal will not touch them', v_probe;
  end if;
  begin
    -- No row at all: still NULL, and still no row.
    v_norow_q := public.allocate_ss_quote_number(v_none);
    v_norow_i := public.allocate_ss_invoice_number(v_none);
    -- A row with no numbering chosen: 1000, then 1001.
    insert into public.client_settings (client_id) values (v_probe);
    v_q := v_q || public.allocate_ss_quote_number(v_probe);
    v_q := v_q || public.allocate_ss_quote_number(v_probe);
    v_i := v_i || public.allocate_ss_invoice_number(v_probe);
    v_i := v_i || public.allocate_ss_invoice_number(v_probe);
    select ss_quote_next, ss_invoice_next into v_qnext, v_inext from public.client_settings where client_id = v_probe;
    -- A new prefix, cleared, over five numbers already issued under it (plus a CRM invoice with a
    -- higher number, which is not ours): one past the highest of OURS.
    update public.client_settings
       set ss_quote_prefix = 'Q-', ss_quote_next = null, ss_invoice_prefix = 'INV-', ss_invoice_next = null
     where client_id = v_probe;
    for i in 0..4 loop
      insert into public.designs (client_id, short_code, status, bldg_w, bldg_h, ss_quote_number)
        values (v_probe, '__m283_' || i || '__', 'draft', 10, 12, 'Q-' || (1000 + i));
      insert into public.invoice_sends (client_id, short_code, issued_by, invoice_number)
        values (v_probe, '__m283_' || i || '__', 'structurestudio', 'INV-' || (1000 + i));
    end loop;
    insert into public.invoice_sends (client_id, short_code, issued_by, invoice_number)
      values (v_probe, '__m283_crm__', 'ghl', 'INV-5000');
    v_q := v_q || public.allocate_ss_quote_number(v_probe);
    v_i := v_i || public.allocate_ss_invoice_number(v_probe);
    raise exception using errcode = 'S2830', message = '283: rehearsal rolled back';
  exception when sqlstate 'S2830' then
    null;
  end;
  if v_norow_q is not null or v_norow_i is not null then
    raise exception '283: a tenant with no settings row was handed % / %, expected nothing',
      coalesce(v_norow_q, 'NULL'), coalesce(v_norow_i, 'NULL');
  end if;
  if v_q is distinct from array['1000', '1001', 'Q-1005'] then
    raise exception '283: the quote rehearsal handed out %, expected 1000, 1001, Q-1005', array_to_string(v_q, ', ', 'NULL');
  end if;
  if v_i is distinct from array['1000', '1001', 'INV-1005'] then
    raise exception '283: the invoice rehearsal handed out %, expected 1000, 1001, INV-1005', array_to_string(v_i, ', ', 'NULL');
  end if;
  if v_qnext is distinct from 1002 or v_inext is distinct from 1002 then
    raise exception '283: after 1000 and 1001 the counters read % / %, expected 1002 / 1002',
      coalesce(v_qnext::text, 'NULL'), coalesce(v_inext::text, 'NULL');
  end if;
  if exists (select 1 from public.client_settings where client_id in (v_probe, v_none))
     or exists (select 1 from public.designs where client_id = v_probe)
     or exists (select 1 from public.invoice_sends where client_id = v_probe) then
    raise exception '283: the rehearsal tenant % was not rolled back', v_probe;
  end if;
  perform set_config('ss.m283_rehearsal',
    'quote ' || array_to_string(v_q, ', ') || '; invoice ' || array_to_string(v_i, ', '), true);

  raise notice '283: checks hold; a blank start now begins at 1000; % existing row(s) unchanged',
    (select count(*) from m283_before);
end
$check$;

-- ── THE RECORD — the one thing `db query` prints ─────────────────────────────────────────
-- Before the commit, so a dry run (last `commit;` swapped for `rollback;`) prints the same row and
-- leaves nothing behind. Expected on 2026-10-07:
--   rehearsal 'quote 1000, 1001, Q-1005; invoice 1000, 1001, INV-1005', rows_checked 5,
--   rows_changed '(none)', paperwork_rows 1, paperwork_rows_with_null_counter 0 (the one paperwork
--   tenant has both numbers set, so nobody starts at 1000 today)
-- Anything else: roll back (see ROLLBACK above) before recording the ledger row.
select
  '283' as migration,
  current_setting('ss.m283_rehearsal', true) as rehearsal,
  (select count(*) from m283_before)::int as rows_checked,
  coalesce((select string_agg(b.client_id, ', ' order by b.client_id)
              from m283_before b join public.client_settings cs on cs.client_id = b.client_id
             where (cs.ss_quote_next, cs.ss_invoice_next) is distinct from (b.ss_quote_next, b.ss_invoice_next)), '(none)') as rows_changed,
  (select count(*) from public.client_settings where invoice_in_ghl = false)::int as paperwork_rows,
  (select count(*) from public.client_settings
    where invoice_in_ghl = false and (ss_quote_next is null or ss_invoice_next is null))::int as paperwork_rows_with_null_counter;

commit;

-- After this: a builder on StructureStudio paperwork who leaves a starting number blank gets 1000 (or one
-- past the last number they issued under that prefix) on their first quote or invoice, instead of a refusal.
