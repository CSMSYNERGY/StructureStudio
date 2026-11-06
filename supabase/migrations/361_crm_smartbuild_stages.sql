-- 361_crm_smartbuild_stages.sql — the SmartBuild starter's stages, as Carolyn actually works a lead.
--
-- ⛔ APPLY BY HAND, AFTER A HUMAN HAS READ IT. Pipe this file to `supabase db query --linked`
--    (stdin; see 270's header) or apply via MCP, then record it:
--      insert into supabase_migrations.schema_migrations (version, name) values ('361', '361_crm_smartbuild_stages') returning version;
--    NEVER `supabase db push`.
--
-- ── NUMBERING ────────────────────────────────────────────────────────────────────────────
-- 361 = max(live ledger, this folder) + 1, both read at 360 immediately before writing (360 was
-- applied earlier today). Re-read BOTH right before applying — four agents write migrations here.
--   select version, name from supabase_migrations.schema_migrations where length(version) <= 4 order by version::int desc limit 5;
--
-- ── WHY (Carolyn, 2026-11-05) ────────────────────────────────────────────────────────────
-- 360 shipped a generic six-stage guess (New / Contacted / Quote Prep / Quoted / Follow-Up /
-- Not Ready / Nurture). She walked the real post-frame process the next morning and it is eight,
-- with the nurture half split by temperature rather than lumped into one column:
--
--   New Lead -> Attempting Contact -> Preparing Quote -> Quoted
--            -> Nurturing - Cool -> Nurturing - Warm -> Nurturing - Hot -> Gone Cold Again
--
-- Her words: "new lead comes in, that's a new lead, and then we attempt to get a hold of them …
-- preparing quote … and then quoted … nurturing - cool, nurturing - warm, nurturing - hot, and
-- then gone cold again."
--
-- Three things worth knowing before editing this list:
--
-- 1. THE VOCABULARY IS HERS AND IT IS ALREADY IN USE. Five of these eight names are the Shed Deals
--    starter's names, to the character, with the same colours: Attempting Contact #0EA5E9,
--    Nurturing - Cool #60A5FA, Warm #F59E0B, Hot #EF4444, Gone Cold Again #94A3B8. A builder who
--    runs both boards should not have to learn two words for one thing, so DO NOT "tidy" one side
--    (an en dash, "Cold" for "Gone Cold Again", a different blue) without doing both.
--
-- 2. "Preparing Quote" and "Quoted" KEEP THE WORD QUOTE, deliberately. Carolyn, weighing it out
--    loud: "since we're using the term estimate, I don't know, Smart Build uses quotes, I think
--    we'll stay with preparing quote." The 2026-10-06 wording rule is about StructureStudio's OWN
--    paperwork, and this is a stage naming a document SmartBuild issues. preflight's
--    checkEstimateWording does not scan migrations, so this does not fight the gate — but a stage
--    name is read by a person, so if the rule is ever widened, this entry is the exception and the
--    sentence above is the reason.
--
-- 3. Still no Won or Lost column (353 + crm_pipeline_stages_open_only): every stage here is open.
--    Sold is the status ladder, which this migration does not touch; lost is a flag on the card.
--    "Gone Cold Again" is NOT a lost column — it is where a quoted lead parks when it goes quiet,
--    and cards come back out of it.
--
-- WHAT THIS CHANGES: only the smartbuild branch's stage list inside crm_seed_pipeline. The ladder,
-- the lost reasons, the other starters and every existing board are untouched — the function only
-- runs when somebody adds a starter, so no tenant's stages move underneath them. structure-studio's
-- board (the only SmartBuild pipeline that exists) was brought to this list by hand first, cards
-- zero, and is the thing to compare against.
--
-- Re-issued from 360's definition, which is the current one (301 / 302 / 303 / 353 / 360 are the
-- earlier ones; nothing has redefined it since 360 landed this morning). If you re-issue it again,
-- read the live one first: this clone has been behind before.
--
-- Rollback:
--   -- re-issue crm_seed_pipeline from 360_crm_smartbuild_starter.sql (its six-stage list).
--   -- Nothing to undo per tenant: no board is rewritten by this migration.

begin;

-- ── crm_seed_pipeline: the smartbuild branch gets Carolyn's eight stages ─────────────────
create or replace function public.crm_seed_pipeline(p_client_id text, p_kind text default 'shed_deals')
returns uuid
language plpgsql
security definer
set search_path to ''
as $fn$
declare
  -- 301's 'sales' and 302's 'quotes' are retired (migration 303): an old caller gets Shed Deals.
  v_kind   text := case when p_kind in ('sales', 'quotes') then 'shed_deals' else p_kind end;
  v_id     uuid;
  v_name   text;
  v_stages jsonb;
  v_ladder jsonb;
  v_lost   text[];
  v_s      jsonb;
  v_i      integer := 0;
  v_pos    double precision;
begin
  if coalesce(btrim(p_client_id), '') = '' then
    raise exception 'a tenant is required' using errcode = 'null_value_not_allowed';
  end if;
  if v_kind = 'shed_deals' then
    v_name := 'Shed Deals';
    v_stages := '[{"n":"New Incoming","c":"#64748B"},{"n":"Attempting Contact","c":"#0EA5E9"},
                  {"n":"Nurturing - Cool","c":"#60A5FA"},{"n":"Nurturing - Warm","c":"#F59E0B"},
                  {"n":"Nurturing - Hot","c":"#EF4444"},{"n":"Gone Cold Again","c":"#94A3B8"}]';
    v_lost := array['Price', 'Went with a competitor', 'Timing', 'No response', 'Not a fit'];
    -- First on the board: it is where new designs land.
    v_pos := coalesce((select min(position) from public.crm_pipelines
                        where client_id = p_client_id and archived_at is null), 2048) - 1024;
  elsif v_kind = 'outreach' then
    v_name := 'Manufacturer Outreach';
    -- Won and Lost were the last two stages here until 353. Sold is the status ladder (Invoiced
    -- onwards); lost is a flag on the card, set where the card already stands.
    v_stages := '[{"n":"New Lead","c":"#64748B"},{"n":"Attempting Contact","c":"#0EA5E9"},
                  {"n":"Connected","c":"#14B8A6"},{"n":"Demo Scheduled","c":"#6366F1"},
                  {"n":"Demo Completed","c":"#8B5CF6"},{"n":"Proposal Sent","c":"#F59E0B"},
                  {"n":"Not Now / Nurture","c":"#94A3B8"}]';
    v_lost := array['Not interested', 'Happy with current software', 'Price', 'Too small', 'Wrong contact / bad number', 'Went with a competitor'];
  elsif v_kind = 'smartbuild' then
    -- Carolyn's stage list for a builder who quotes in SmartBuild (2026-11-05, replacing 360's
    -- guess — see this file's WHY for her words and for why "Quote" stays). Preparing Quote is the
    -- handoff point: that is where the Hub will push the contact to SmartBuild once the sync is
    -- built. The nurture half is split by temperature, matching Shed Deals. No Won or Lost column.
    v_name := 'SmartBuild Jobs';
    v_stages := '[{"n":"New Lead","c":"#64748B"},{"n":"Attempting Contact","c":"#0EA5E9"},
                  {"n":"Preparing Quote","c":"#6366F1"},{"n":"Quoted","c":"#8B5CF6"},
                  {"n":"Nurturing - Cool","c":"#60A5FA"},{"n":"Nurturing - Warm","c":"#F59E0B"},
                  {"n":"Nurturing - Hot","c":"#EF4444"},{"n":"Gone Cold Again","c":"#94A3B8"}]';
    -- SmartBuild's own ladder, unchanged by this migration. Only Contact Made has an event the
    -- product already raises; the other four wait for the sync (354's placeholder rungs). Keep them
    -- NULL rather than wiring them to design events a SmartBuild builder never fires.
    v_ladder := '[{"n":"New","c":"#64748B"},
                  {"n":"Contact Made","c":"#0EA5E9","e":"contact_made"},
                  {"n":"Quoted","c":"#F59E0B"},
                  {"n":"Contracted","c":"#16A34A"},
                  {"n":"Order Prep","c":"#14B8A6"},
                  {"n":"Ordered","c":"#0F766E"}]';
    v_lost := array['Price', 'Went with a competitor', 'Timing', 'No response', 'Not a fit'];
  else
    raise exception 'unknown starter pipeline %', p_kind using errcode = 'invalid_parameter_value';
  end if;
  if v_pos is null then
    v_pos := coalesce((select max(position) from public.crm_pipelines where client_id = p_client_id), 0) + 1024;
  end if;

  insert into public.crm_pipelines (client_id, name, lost_reasons, seed_kind, position, feeds_designs, mirrors_statuses)
  values (p_client_id, v_name, v_lost, v_kind, v_pos,
          v_kind = 'shed_deals' and not exists (select 1 from public.crm_pipelines o
                                                where o.client_id = p_client_id and o.feeds_designs and o.archived_at is null),
          false)
  on conflict (client_id, seed_kind) where seed_kind is not null do nothing
  returning id into v_id;
  if v_id is null then
    select id into v_id from public.crm_pipelines where client_id = p_client_id and seed_kind = v_kind;
    return v_id;
  end if;

  for v_s in select * from jsonb_array_elements(v_stages) loop
    v_i := v_i + 1;
    insert into public.crm_pipeline_stages (client_id, pipeline_id, name, color, kind, position)
    values (p_client_id, v_id, v_s->>'n', v_s->>'c', coalesce(v_s->>'k', 'open'), v_i * 1024);
  end loop;

  -- A starter that brings its own ladder seeds it here. Without this the pipeline would have no
  -- statuses, and the next crm_seed_statuses(client) sweep would hand it the DESIGN ladder —
  -- eight rungs about estimates and deliveries, on a pipeline whose builder has no designer.
  if v_ladder is not null then
    v_i := 0;
    for v_s in select * from jsonb_array_elements(v_ladder) loop
      v_i := v_i + 1;
      insert into public.crm_statuses (client_id, pipeline_id, name, color, trigger_event, position)
      values (p_client_id, v_id, v_s->>'n', v_s->>'c', v_s->>'e', v_i * 1024);
    end loop;
  end if;
  return v_id;
end;
$fn$;
revoke execute on function public.crm_seed_pipeline(text, text) from public, anon, authenticated;
grant  execute on function public.crm_seed_pipeline(text, text) to service_role;

-- ── CHECKS ──────────────────────────────────────────────────────────────────────────────
do $$
declare
  v_c text := 'zz-m361-rehearsal';
  v_p uuid;
  v_stages text;
  v_rungs  text;
  v_events text;
  v_shed   text;
begin
  -- A made-up account, removed again below: proving the branch on a real tenant would leave a
  -- pipeline somebody has to find and delete.
  insert into public.crm_pipelines (client_id, name, position) values (v_c, 'placeholder', 1024);

  v_p := public.crm_seed_pipeline(v_c, 'smartbuild');
  if v_p is null then raise exception '361: the smartbuild starter returned no pipeline'; end if;

  select string_agg(name, ' -> ' order by position) into v_stages
    from public.crm_pipeline_stages where pipeline_id = v_p and archived_at is null;
  if v_stages <> 'New Lead -> Attempting Contact -> Preparing Quote -> Quoted -> '
               || 'Nurturing - Cool -> Nurturing - Warm -> Nurturing - Hot -> Gone Cold Again' then
    raise exception '361: unexpected stages: %', v_stages;
  end if;

  -- The ladder is NOT what changed. If this fires, something re-issued the function from an older
  -- definition and took 360's statuses with it.
  select string_agg(name, ' -> ' order by position) into v_rungs
    from public.crm_statuses where pipeline_id = v_p and archived_at is null;
  if v_rungs <> 'New -> Contact Made -> Quoted -> Contracted -> Order Prep -> Ordered' then
    raise exception '361: unexpected status ladder: %', v_rungs;
  end if;

  -- Exactly one rung is driveable today, and it is Contact Made.
  select string_agg(name, ',' order by position) into v_events
    from public.crm_statuses where pipeline_id = v_p and trigger_event is not null;
  if coalesce(v_events, '') <> 'Contact Made' then
    raise exception '361: expected only Contact Made to carry an event, got %', coalesce(v_events, '(none)');
  end if;

  -- Idempotent: asking twice is the same pipeline, not a second one.
  if public.crm_seed_pipeline(v_c, 'smartbuild') <> v_p then
    raise exception '361: a second call made a different pipeline';
  end if;

  -- The other starters still work. Shed Deals is checked by NAME, not just for existing: five of
  -- the SmartBuild names are borrowed from it, so a careless edit to one list that lands in the
  -- other is exactly the mistake worth catching here.
  if public.crm_seed_pipeline(v_c, 'outreach') is null then
    raise exception '361: the outreach starter broke';
  end if;
  if public.crm_seed_pipeline(v_c, 'shed_deals') is null then
    raise exception '361: the shed_deals starter broke';
  end if;
  select string_agg(s.name, ' -> ' order by s.position) into v_shed
    from public.crm_pipeline_stages s join public.crm_pipelines p on p.id = s.pipeline_id
   where p.client_id = v_c and p.seed_kind = 'shed_deals' and s.archived_at is null;
  if coalesce(v_shed, '') <> 'New Incoming -> Attempting Contact -> Nurturing - Cool -> '
                          || 'Nurturing - Warm -> Nurturing - Hot -> Gone Cold Again' then
    raise exception '361: the Shed Deals stages changed: %', coalesce(v_shed, '(none)');
  end if;
  if exists (select 1 from public.crm_pipeline_stages
              where client_id = v_c and archived_at is null and kind <> 'open') then
    raise exception '361: a starter seeded a non-open stage';
  end if;

  delete from public.crm_pipelines where client_id = v_c;
  if exists (select 1 from public.crm_statuses where client_id = v_c) then
    raise exception '361: rehearsal statuses outlived their pipelines';
  end if;
end $$;

commit;
