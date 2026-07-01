-- 031_design_versions: append-only version history for designs.
--
-- A resubmit still updates the single GHL estimate in place (one estimate per design),
-- but every submitted version — full geometry + selections + its own PDF — is now
-- preserved so a customer can reopen a previous design later. The owner portal lists
-- versions newest-first under each design; the public designer opens a specific version
-- via the load_design_version capability RPC (keyed by the unguessable code).
--
-- NB: applied to live via MCP on 2026-06-30 (recorded as a timestamped migration);
-- this NNN_ file is the repo record — reconcile with the migration-history ledger.

create table if not exists public.design_versions (
  id             uuid primary key default gen_random_uuid(),
  short_code     text not null,
  client_id      text not null,
  version        int  not null,
  contact        jsonb not null default '{}'::jsonb,
  selections     jsonb not null default '{}'::jsonb,
  paint_colors   jsonb not null default '{}'::jsonb,
  items          jsonb not null default '[]'::jsonb,
  custom_options jsonb not null default '[]'::jsonb,
  ro_dimensions  jsonb not null default '{}'::jsonb,
  bldg_w         integer,
  bldg_h         integer,
  image_url      text,
  created_at     timestamptz not null default now(),
  unique (short_code, version)
);
create index if not exists design_versions_lookup on public.design_versions (client_id, short_code, version desc);

alter table public.design_versions enable row level security;
drop policy if exists design_versions_owner_select on public.design_versions;
create policy design_versions_owner_select on public.design_versions
  for select to authenticated using (client_id = public.current_client_id());

-- Widen the floor-plan storage policies to allow an optional numeric suffix on the code
-- (e.g. junior-barns/SS-XXXX-1782000000000.pdf) so each version keeps its own PDF instead
-- of overwriting the last one. Legacy junior-barns/SS-CODE.pdf still matches.
drop policy if exists floor_plans_code_insert on storage.objects;
drop policy if exists floor_plans_code_select on storage.objects;
drop policy if exists floor_plans_code_update on storage.objects;
create policy floor_plans_code_insert on storage.objects for insert to public
  with check (bucket_id = 'floor-plans' and name ~ '^[a-z0-9][a-z0-9-]*/SS-[A-HJ-NP-Z2-9]{6,12}(-[0-9]+)?[.]pdf$');
create policy floor_plans_code_select on storage.objects for select to public
  using (bucket_id = 'floor-plans' and name ~ '^[a-z0-9][a-z0-9-]*/SS-[A-HJ-NP-Z2-9]{6,12}(-[0-9]+)?[.]pdf$');
create policy floor_plans_code_update on storage.objects for update to public
  using (bucket_id = 'floor-plans' and name ~ '^[a-z0-9][a-z0-9-]*/SS-[A-HJ-NP-Z2-9]{6,12}(-[0-9]+)?[.]pdf$')
  with check (bucket_id = 'floor-plans' and name ~ '^[a-z0-9][a-z0-9-]*/SS-[A-HJ-NP-Z2-9]{6,12}(-[0-9]+)?[.]pdf$');

-- save_design now also appends a snapshot to design_versions on every call.
create or replace function public.save_design(p_code text, p_client_id text, p_contact jsonb, p_selections jsonb, p_paint_colors jsonb, p_items jsonb, p_custom_options jsonb, p_ro_dimensions jsonb, p_bldg_w integer, p_bldg_h integer, p_image_url text)
 returns designs
 language plpgsql
 security definer
 set search_path to ''
as $function$
declare
  v_existing_client text;
  v_row public.designs;
begin
  if p_code is null or p_code !~ '^SS-[A-HJ-NP-Z2-9]{6,12}$' then
    raise exception 'invalid design code';
  end if;
  if not exists (select 1 from public.client_configs where client_id = p_client_id) then
    raise exception 'unknown client';
  end if;
  select client_id into v_existing_client from public.designs where short_code = p_code;
  if v_existing_client is not null and v_existing_client <> p_client_id then
    raise exception 'design belongs to a different client';
  end if;

  insert into public.designs
    (short_code, client_id, contact, selections, paint_colors, items,
     custom_options, ro_dimensions, bldg_w, bldg_h, image_url)
  values
    (p_code, p_client_id,
     coalesce(p_contact, '{}'::jsonb),
     coalesce(p_selections, '{}'::jsonb),
     coalesce(p_paint_colors, '{}'::jsonb),
     coalesce(p_items, '[]'::jsonb),
     coalesce(p_custom_options, '[]'::jsonb),
     coalesce(p_ro_dimensions, '{}'::jsonb),
     p_bldg_w, p_bldg_h, p_image_url)
  on conflict (short_code) do update set
    contact        = excluded.contact,
    selections     = excluded.selections,
    paint_colors   = excluded.paint_colors,
    items          = excluded.items,
    custom_options = excluded.custom_options,
    ro_dimensions  = excluded.ro_dimensions,
    bldg_w         = excluded.bldg_w,
    bldg_h         = excluded.bldg_h,
    image_url      = excluded.image_url,
    updated_at     = now()
  returning * into v_row;

  insert into public.design_versions
    (short_code, client_id, version, contact, selections, paint_colors, items,
     custom_options, ro_dimensions, bldg_w, bldg_h, image_url)
  values
    (v_row.short_code, v_row.client_id,
     coalesce((select max(version) from public.design_versions where short_code = p_code), 0) + 1,
     v_row.contact, v_row.selections, v_row.paint_colors, v_row.items,
     v_row.custom_options, v_row.ro_dimensions, v_row.bldg_w, v_row.bldg_h, v_row.image_url);

  return v_row;
end
$function$;

-- Capability read of a single version, keyed by the unguessable code (mirrors load_design).
create or replace function public.load_design_version(p_code text, p_version int)
 returns public.design_versions
 language sql
 security definer
 set search_path to ''
as $function$
  select * from public.design_versions where short_code = p_code and version = p_version;
$function$;
grant execute on function public.load_design_version(text, int) to anon, authenticated;
