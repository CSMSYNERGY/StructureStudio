-- 360_crm_smartbuild_starter.sql — a SmartBuild starter pipeline a builder can be given in one click.
--
-- ⛔ APPLY BY HAND, AFTER A HUMAN HAS READ IT. Pipe this file to `supabase db query --linked`
--    (stdin; see 270's header) or apply via MCP, then record it:
--      insert into supabase_migrations.schema_migrations (version, name) values ('360', '360_crm_smartbuild_starter') returning version;
--    NEVER `supabase db push`.
--
-- ── NUMBERING ────────────────────────────────────────────────────────────────────────────
-- 360 = max(live ledger, this folder) + 1, both read at 359 immediately before writing (359 was
-- applied earlier this session). Re-read BOTH right before applying — four agents write
-- migrations here and this folder has been ten behind the database before.
--   select version, name from supabase_migrations.schema_migrations where length(version) <= 4 order by version::int desc limit 5;
--
-- ── WHY (Carolyn, 2026-11-04) ────────────────────────────────────────────────────────────
-- The first SmartBuild builder onboards tomorrow. 354 made statuses per-pipeline for exactly
-- this — its own WHY quotes her: "now I also brought on a Smart Build User and plan to integrate
-- with Smart Build. I want to make specific statuses per pipeline" — but the pipeline itself still
-- had to be typed in by hand: one stage at a time, then a status ladder, for every builder who
-- works this way. This adds it as a STARTER, the same mechanism Shed Deals and Manufacturer
-- Outreach already use (crm_seed_pipeline), so setting a builder up is one click.
--
-- The stages are hers: new -> contacted -> quote prep -> quoted -> follow-up -> not ready
-- (nurture). Note what is NOT a stage: WON and LOST. Since 353 an outcome is not a column —
-- crm_pipeline_stages_open_only refuses a live stage of either kind, won is the status ladder and
-- lost is a flag on the card where it already stands. A reader coming from her list will look for
-- those two columns; this is where they went.
--
-- ── THE STATUS LADDER, AND THE ONE RUNG THAT WORKS TODAY ─────────────────────────────────
-- SmartBuild's own ladder (new -> quoted -> contracted -> order prep -> ordered) will be driven by
-- the SmartBuild sync, which does not exist yet. 354 anticipated this: "a status may now sit with
-- NO trigger_event — a placeholder for a rung the SmartBuild webhooks will drive later. Nobody can
-- set it by hand in the meantime; it simply waits." So four rungs are placeholders.
--
-- Contact Made is NOT a placeholder. `contact_made` is one of the eight events the Hub already
-- records (a logged call, text or email), so that rung moves on day one, before any sync exists.
-- The builder gets a pipeline that does something immediately rather than one that sits inert.
-- The remaining four are deliberately left for the sync rather than wired to a design event:
-- a SmartBuild builder does not use our designer, so design_submitted / estimate_sent / invoiced
-- would never fire for them and would read as broken rungs.
--
-- ── SAFE WITH WHAT IS LIVE ───────────────────────────────────────────────────────────────
-- Additive, and it seeds NOTHING on its own. crm_seed_pipeline gains one branch; no existing
-- branch, signature or caller changes, and crm_ensure_pipelines is untouched, so a new account
-- still seeds Shed Deals only (303) and no existing builder gains a pipeline. The starter appears
-- only when somebody asks for it by kind, through portal-settings' crm_pipeline_add_starter.
--
-- The whole function is re-issued because plpgsql has no other way to add a branch. The body below
-- is the LIVE definition (read with pg_get_functiondef immediately before writing this, and it
-- matches 353's shape) with the smartbuild branch and its status seeding added — nothing else is
-- touched. If you re-issue it again, read the live one first: this clone has been behind before.
--
-- Rollback:
--   -- re-issue crm_seed_pipeline from 353_crm_outcomes_not_stages.sql, then, per tenant given it:
--   -- delete from public.crm_pipelines where client_id = '<slug>' and seed_kind = 'smartbuild';
--   -- (statuses, stages and deals cascade from the pipeline row)

begin;

-- ── crm_seed_pipeline: + the 'smartbuild' starter ───────────────────────────────────────
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
    -- Carolyn's stage list for a builder who quotes in SmartBuild (2026-11-04). Quote Prep is the
    -- handoff point: that is where the Hub will push the contact to SmartBuild once the sync is
    -- built. No Won or Lost column — see this file's WHY.
    v_name := 'SmartBuild Jobs';
    v_stages := '[{"n":"New","c":"#64748B"},{"n":"Contacted","c":"#0EA5E9"},
                  {"n":"Quote Prep","c":"#6366F1"},{"n":"Quoted","c":"#F59E0B"},
                  {"n":"Follow-Up","c":"#8B5CF6"},{"n":"Not Ready / Nurture","c":"#94A3B8"}]';
    -- SmartBuild's own ladder. Only Contact Made has an event the product already raises; the
    -- other four wait for the sync (354's placeholder rungs). Keep them NULL rather than wiring
    -- them to design events a SmartBuild builder never fires.
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
  v_c text := 'zz-m360-rehearsal';
  v_p uuid;
  v_stages text;
  v_rungs  text;
  v_events text;
begin
  -- A made-up account, removed again below: proving the branch on a real tenant would leave a
  -- pipeline somebody has to find and delete.
  insert into public.crm_pipelines (client_id, name, position) values (v_c, 'placeholder', 1024);

  v_p := public.crm_seed_pipeline(v_c, 'smartbuild');
  if v_p is null then raise exception '360: the smartbuild starter returned no pipeline'; end if;

  select string_agg(name, ' -> ' order by position) into v_stages
    from public.crm_pipeline_stages where pipeline_id = v_p and archived_at is null;
  if v_stages <> 'New -> Contacted -> Quote Prep -> Quoted -> Follow-Up -> Not Ready / Nurture' then
    raise exception '360: unexpected stages: %', v_stages;
  end if;

  select string_agg(name, ' -> ' order by position) into v_rungs
    from public.crm_statuses where pipeline_id = v_p and archived_at is null;
  if v_rungs <> 'New -> Contact Made -> Quoted -> Contracted -> Order Prep -> Ordered' then
    raise exception '360: unexpected status ladder: %', v_rungs;
  end if;

  -- Exactly one rung is driveable today, and it is Contact Made.
  select string_agg(name, ',' order by position) into v_events
    from public.crm_statuses where pipeline_id = v_p and trigger_event is not null;
  if coalesce(v_events, '') <> 'Contact Made' then
    raise exception '360: expected only Contact Made to carry an event, got %', coalesce(v_events, '(none)');
  end if;

  -- Idempotent: asking twice is the same pipeline, not a second one.
  if public.crm_seed_pipeline(v_c, 'smartbuild') <> v_p then
    raise exception '360: a second call made a different pipeline';
  end if;

  -- The other starters still work, and nothing here is a won/lost column.
  if public.crm_seed_pipeline(v_c, 'outreach') is null then
    raise exception '360: the outreach starter broke';
  end if;
  if exists (select 1 from public.crm_pipeline_stages
              where client_id = v_c and archived_at is null and kind <> 'open') then
    raise exception '360: a starter seeded a non-open stage';
  end if;

  delete from public.crm_pipelines where client_id = v_c;
  if exists (select 1 from public.crm_statuses where client_id = v_c) then
    raise exception '360: rehearsal statuses outlived their pipelines';
  end if;
end $$;

commit;
