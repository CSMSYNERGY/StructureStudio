-- 290_tax_codes_enabled.sql — the "Use tax codes" switch on Settings → Company → Tax.
--
-- ⛔ APPLY BY HAND, AFTER A HUMAN HAS READ IT, and only once Ahsan says go. Run it with
--      supabase db query --linked --file supabase/migrations/290_tax_codes_enabled.sql
--    then record it:
--      insert into supabase_migrations.schema_migrations (version, name) values ('290', '290_tax_codes_enabled') returning version;
--    NEVER `supabase db push`. The file carries its own begin;/commit;, so a failed check anywhere
--    takes the whole migration with it. `db query` prints no NOTICE, only the last statement's rows:
--    THE RECORD at the end is what the apply shows. ⛔ HARD STOP: `--file` has been seen to
--    auth-fail, retry and still exit 0 (232's header), so the exit code proves nothing.
--    NO RECORD ROW PRINTED MEANS THE FILE DID NOT RUN: do not record the ledger row, read the
--    column back (below) and find out why. To see the same row and change nothing, run it with the
--    last `commit;` swapped for `rollback;` (a dry run) first.
--    The number is TENTATIVE: renumber the file (and every '290' in it) at apply time if the
--    ledger already holds 290 (see NUMBERING).
--
-- ── WHY ──────────────────────────────────────────────────────────────────────────────────
-- The company sales tax rate moves to Settings → Company → Tax (portal-settings save_company_tax),
-- and the tax code editor under it gets a switch. Most builders sell at one rate and never pick a
-- code, so a builder who has saved no codes starts with the editor folded away; a builder who
-- already saved codes keeps seeing them (the plan's read on 2026-10-09: one builder, 24 codes).
-- No tax changes with it: codes are saved, not used, and nothing that prices, prints or invoices
-- an estimate reads this column (see _shared/companyTax.ts for the rule a later per-line stage
-- will follow).
--
-- ── WHAT THIS DOES ───────────────────────────────────────────────────────────────────────
--   * client_settings.tax_codes_enabled boolean NOT NULL DEFAULT false, with a column comment.
--     ADD COLUMN with a constant default is a catalog change (no rewrite) on a table of a handful
--     of rows. Every row reads false, and so does every row created from now on.
--   * ON THE FIRST APPLY ONLY, the switch is turned on for every builder that has a
--     tax_code_assignments row AND a client_settings row. (A builder with codes but no settings
--     row cannot be switched on, because there is no row to hold it; the RECORD counts them, and
--     their first save creates the row with the switch off and their codes kept.) A re-apply finds
--     the column already there and moves nobody: by then builders have chosen.
--
-- ── WHAT THIS DOES NOT DO ────────────────────────────────────────────────────────────────
--   * Touches no other column: no rate, label, mode, numbering or CRM value, and not updated_at
--     (the switch is the platform's starting point, not an owner's save). The checks prove it.
--   * Deletes no code. tax_code_assignments is only read. Switching codes off in the portal keeps
--     every code too.
--   * No get_config splice, no policy, no grant, no function: the designer never reads it, and the
--     portal learns it only through portal-settings (service_role).
--
-- ── SAFE WITH WHAT IS LIVE ───────────────────────────────────────────────────────────────
-- Beta and production share this database, so the column is live for both the moment this
-- commits. Every live writer upserts NAMED columns, and INSERT ... ON CONFLICT DO UPDATE sets only
-- the columns it names, so nothing written by production's pages ever touches the new column.
-- The ALTER takes a brief ACCESS EXCLUSIVE lock on client_settings, which every estimate and every
-- Settings read touches; lock_timeout makes a hung apply give up instead. The table has no trigger.
-- client_settings stays service-role only: RLS on, no policy, nothing for the browser roles, and
-- FORCE row level security stays OFF (get_config is SECURITY DEFINER and reads this table; with
-- FORCE on, its reads would be filtered by RLS and every public designer would break: 154 PART 4).
--
-- ── NUMBERING ────────────────────────────────────────────────────────────────────────────
-- origin/beta 2026-10-09: 289 (the door generator) is the newest file; 288 is held by another
-- batch. 290 is this batch's working number. Confirm at apply time, and record the ledger row with
-- `returning`: no row back means 290 was taken, so rename.
--   select version from supabase_migrations.schema_migrations order by 1 desc limit 4;
--
-- ── ORDER ────────────────────────────────────────────────────────────────────────────────
-- Push to beta first (Ahsan's go), then this file (a separate go), then portal-settings (its
-- tax_codes_get answers taxCodesEnabled), then the beta portal. Either order of this file and the
-- function is survivable: portal-settings reads the column in its own TOLERANT read (a missing
-- column answers taxCodesEnabled null, and the Tax tab then shows today's editor with no switch),
-- and save_company_tax names the column only when the switch itself is sent, which a page shows
-- only once the read answered a boolean.
--
-- ── VERIFY (read-only) ───────────────────────────────────────────────────────────────────
--   select column_default, is_nullable, data_type from information_schema.columns
--    where table_schema = 'public' and table_name = 'client_settings' and column_name = 'tax_codes_enabled';
--   select count(*) filter (where tax_codes_enabled) as on_, count(*) as rows from public.client_settings;
--
-- ── ROLLBACK ─────────────────────────────────────────────────────────────────────────────
-- Put back the portal-settings without the switch first if it is live (a save that carries the
-- switch would fail on a missing column; tax_codes_get's tolerant read survives either way). Each
-- builder's choice is lost with the column: one who switched codes off sees the editor again.
--   alter table public.client_settings drop column if exists tax_codes_enabled;
--   notify pgrst, 'reload schema';
--   delete from supabase_migrations.schema_migrations where version = '290';
-- Codes themselves are untouched by this file and by its rollback.

begin;

-- The ALTER takes ACCESS EXCLUSIVE on client_settings (brief: a catalog change). A hung apply must
-- give up rather than sit in front of every estimate's settings read.
set local lock_timeout = '5s';

-- Was the column already here? On the first apply the builders with codes are switched on; a
-- re-apply comes after builders have chosen, and must keep what they chose.
select set_config('ss.m290_first_apply', (not exists (
  select 1 from information_schema.columns
   where table_schema = 'public' and table_name = 'client_settings' and column_name = 'tax_codes_enabled'
))::text, true);

-- Every row BEFORE anything here runs, so the checks can prove which rows moved and that nothing
-- else did. `codes_before` is the switch as it stood (NULL on the first apply, when the column
-- does not exist yet: to_jsonb reads whatever columns the row has, so this needs no branch).
create temp table m290_before on commit drop as
  select cs.client_id, cs.invoice_in_ghl, cs.ghl_invoicing_allowed, cs.ss_tax_rate, cs.ss_tax_label,
         cs.ss_tax_delivery, cs.ss_quote_next, cs.ss_invoice_next, cs.updated_at,
         to_jsonb(cs) -> 'tax_codes_enabled' as codes_before
    from public.client_settings cs;

-- ── THE CHANGE ───────────────────────────────────────────────────────────────────────────
alter table public.client_settings
  add column if not exists tax_codes_enabled boolean not null default false;

comment on column public.client_settings.tax_codes_enabled is
  'The "Use tax codes" switch on Settings → Company → Tax (portal-settings save_company_tax). Off: '
  'the tax code editor is folded away and every taxable item is charged the company rate chain as '
  'before; on: the builder picks an Avalara code per building style and option heading '
  '(tax_code_assignments). Switching off keeps every saved code. Nothing that prices, prints or '
  'invoices an estimate reads it yet. Default false; migration 290 turned it on, on its first apply, '
  'for every builder that already had codes.';

-- First apply only: the builders who already saved codes keep seeing them.
update public.client_settings cs
   set tax_codes_enabled = true
 where current_setting('ss.m290_first_apply')::boolean
   and exists (select 1 from public.tax_code_assignments t where t.client_id = cs.client_id);

-- ── CHECKS: raise (and so roll the whole file back) rather than commit a surprise ───────
do $check$
declare
  v_col    record;
  v_first  constant boolean := current_setting('ss.m290_first_apply')::boolean;
  v_n      integer;
  v_role   text;
  v_priv   text;
  v_probe  constant text := '__m290_rehearsal__';
  v_new    boolean;
begin
  -- ── The column: boolean, NOT NULL, default false ──
  select c.data_type, c.is_nullable, c.column_default into v_col
    from information_schema.columns c
   where c.table_schema = 'public' and c.table_name = 'client_settings' and c.column_name = 'tax_codes_enabled';
  if v_col.data_type is null then
    raise exception '290: client_settings.tax_codes_enabled is missing after the ALTER';
  end if;
  if v_col.data_type <> 'boolean' or v_col.is_nullable <> 'NO' or v_col.column_default is distinct from 'false' then
    raise exception '290: client_settings.tax_codes_enabled should be boolean NOT NULL DEFAULT false, is % / nullable % / default %',
      v_col.data_type, v_col.is_nullable, v_col.column_default;
  end if;

  -- ── Which rows are on ──
  if v_first then
    -- Exactly the builders with codes AND a settings row, and nobody else.
    select count(*) into v_n
      from public.client_settings cs
     where cs.tax_codes_enabled is distinct from
           exists (select 1 from public.tax_code_assignments t where t.client_id = cs.client_id);
    if v_n > 0 then
      raise exception '290: % row(s) are switched the wrong way on the first apply (on must mean "has codes")', v_n;
    end if;
    if (select count(*) from public.client_settings where tax_codes_enabled)
       <> (select count(distinct t.client_id) from public.tax_code_assignments t
            where exists (select 1 from public.client_settings cs where cs.client_id = t.client_id)) then
      raise exception '290: the switched-on count is not the number of builders with codes and a settings row';
    end if;
  else
    -- A re-apply moves nobody's switch.
    select count(*) into v_n
      from m290_before b join public.client_settings cs on cs.client_id = b.client_id
     where to_jsonb(cs.tax_codes_enabled) is distinct from b.codes_before;
    if v_n > 0 then
      raise exception '290: a re-apply changed % builder(s)'' tax codes switch; it must keep what they chose', v_n;
    end if;
  end if;

  -- ── Nothing else moved: mode, capability, rate, label, delivery, numbering, updated_at ──
  select count(*) into v_n
    from m290_before b
    left join public.client_settings cs on cs.client_id = b.client_id
   where cs.client_id is null
      or (cs.invoice_in_ghl, cs.ghl_invoicing_allowed, cs.ss_tax_rate, cs.ss_tax_label, cs.ss_tax_delivery,
          cs.ss_quote_next, cs.ss_invoice_next, cs.updated_at)
         is distinct from
         (b.invoice_in_ghl, b.ghl_invoicing_allowed, b.ss_tax_rate, b.ss_tax_label, b.ss_tax_delivery,
          b.ss_quote_next, b.ss_invoice_next, b.updated_at);
  if v_n > 0 then
    raise exception '290: % client_settings row(s) changed in a column this file does not touch', v_n;
  end if;
  if (select count(*) from m290_before) <> (select count(*) from public.client_settings) then
    raise exception '290: the row count moved during the apply — run it again';
  end if;

  -- ── Still service-role only: RLS on and NOT forced, no policy, nothing for the browser roles ──
  if not (select c.relrowsecurity from pg_catalog.pg_class c where c.oid = 'public.client_settings'::regclass) then
    raise exception '290: RLS is off on client_settings';
  end if;
  if (select c.relforcerowsecurity from pg_catalog.pg_class c where c.oid = 'public.client_settings'::regclass) then
    raise exception '290: client_settings has FORCE ROW LEVEL SECURITY on; get_config (SECURITY DEFINER) reads it, so every designer would break. Resolve before applying.';
  end if;
  if exists (select 1 from pg_catalog.pg_policy p where p.polrelid = 'public.client_settings'::regclass) then
    raise exception '290: client_settings has a policy; it is meant to be service-role only';
  end if;
  foreach v_role in array array['anon', 'authenticated'] loop
    foreach v_priv in array array['SELECT', 'INSERT', 'UPDATE'] loop
      if has_column_privilege(v_role, 'public.client_settings', 'tax_codes_enabled', v_priv) then
        raise exception '290: % holds % on client_settings.tax_codes_enabled', v_role, v_priv;
      end if;
    end loop;
  end loop;
  foreach v_priv in array array['SELECT', 'INSERT', 'UPDATE'] loop
    if not has_column_privilege('service_role', 'public.client_settings', 'tax_codes_enabled', v_priv) then
      raise exception '290: service_role lacks % on client_settings.tax_codes_enabled — the Tax tab''s switch would fail', v_priv;
    end if;
  end loop;

  -- ── The rehearsal: a brand-new row, the way a first save creates one, and roll it back ──
  -- A sub-block whose own exception is its rollback: the insert is undone and only the answer
  -- (a plain variable) survives it. Only client_id is named, so every other column takes its default.
  if exists (select 1 from public.client_settings where client_id = v_probe) then
    raise exception '290: a client_settings row named % already exists; the rehearsal will not touch it', v_probe;
  end if;
  begin
    insert into public.client_settings (client_id) values (v_probe) returning tax_codes_enabled into v_new;
    raise exception using errcode = 'S2900', message = '290: rehearsal rolled back';
  exception when sqlstate 'S2900' then
    null;
  end;
  if v_new is distinct from false then
    raise exception '290: a new client_settings row starts with tax_codes_enabled = %, expected false', coalesce(v_new::text, 'null');
  end if;
  if exists (select 1 from public.client_settings where client_id = v_probe) then
    raise exception '290: the rehearsal row % was not rolled back', v_probe;
  end if;
  perform set_config('ss.m290_new_row', v_new::text, true);

  raise notice '290: checks hold; tax_codes_enabled defaults to false; first apply %; % row(s) on',
    v_first::text, (select count(*) from public.client_settings where tax_codes_enabled);
end
$check$;

notify pgrst, 'reload schema';

-- ── THE RECORD — the one thing `db query` prints ─────────────────────────────────────────
-- Counts only: no builder is named. Before the commit, so a dry run (last `commit;` swapped for
-- `rollback;`) prints the same row and leaves nothing behind. Expected on the first apply, IF the
-- live counts are still the ones 287 (5 settings rows) and the plan (one builder with codes) read;
-- re-count both, read-only, before applying and expect those instead:
--   tax_codes_enabled_default 'false', first_apply 'true', rows_total 5, tenants_with_codes 1,
--   switched_on 1, codes_without_settings_row 0, rows_changed 0, browser_can_read false,
--   new_row_starts 'false'
-- switched_on must equal tenants_with_codes minus codes_without_settings_row, and rows_changed must
-- be 0. Anything else: roll back (see ROLLBACK above) before recording the ledger row.
select
  '290' as migration,
  (select c.column_default from information_schema.columns c
    where c.table_schema = 'public' and c.table_name = 'client_settings' and c.column_name = 'tax_codes_enabled') as tax_codes_enabled_default,
  current_setting('ss.m290_first_apply') as first_apply,
  (select count(*) from public.client_settings)::int as rows_total,
  (select count(distinct t.client_id) from public.tax_code_assignments t)::int as tenants_with_codes,
  (select count(*) from public.client_settings where tax_codes_enabled)::int as switched_on,
  (select count(distinct t.client_id) from public.tax_code_assignments t
    where not exists (select 1 from public.client_settings cs where cs.client_id = t.client_id))::int as codes_without_settings_row,
  (select count(*) from m290_before b join public.client_settings cs on cs.client_id = b.client_id
    where (cs.invoice_in_ghl, cs.ghl_invoicing_allowed, cs.ss_tax_rate, cs.ss_tax_label, cs.ss_tax_delivery,
           cs.ss_quote_next, cs.ss_invoice_next, cs.updated_at)
          is distinct from
          (b.invoice_in_ghl, b.ghl_invoicing_allowed, b.ss_tax_rate, b.ss_tax_label, b.ss_tax_delivery,
           b.ss_quote_next, b.ss_invoice_next, b.updated_at))::int as rows_changed,
  (has_column_privilege('anon', 'public.client_settings', 'tax_codes_enabled', 'SELECT')
    or has_column_privilege('authenticated', 'public.client_settings', 'tax_codes_enabled', 'SELECT')) as browser_can_read,
  current_setting('ss.m290_new_row', true) as new_row_starts;

commit;

-- After this: every builder who had saved tax codes still sees them on the Tax tab, every other
-- builder starts with the code editor folded away, and no estimate's tax moved.
