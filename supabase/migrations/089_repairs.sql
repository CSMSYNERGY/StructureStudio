-- 089_repairs: the full Repairs tab data model (decision 3 — not a placeholder).
--
-- A repair is logged ONCE (customer + building + problem), then scheduled where the work
-- actually happens: shop work becomes a build_jobs row (source='repair'), field visits and
-- pick-up/return hauls become delivery_stops (090). Repair status is its own small
-- customer-facing lifecycle — FIXED vocabulary, not tenant-custom (reports need it stable);
-- the schedule jobs are the shop's execution view.
--
-- "Not one of ours" is allowed: builders repair competitors' sheds too, so every building
-- link is nullable. When the building IS ours, serial / design_short_code / unit id give
-- service history that follows the building forever.

create table public.repairs (
  id uuid primary key default gen_random_uuid(),
  client_id text not null,
  -- Nullable so inserts can omit it; the BEFORE INSERT trigger below always fills it.
  repair_no bigint,
  customer_name text not null,
  phone text,
  email text,
  design_short_code text,
  inventory_unit_id uuid references public.inventory_units(id) on delete set null,
  serial bigint,
  description text not null,
  status text not null default 'requested'
    check (status in ('requested','approved','in_progress','completed','declined')),
  quote_cents integer,
  notes text,
  requested_at timestamptz not null default now(),
  completed_at timestamptz,
  created_by uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (client_id, repair_no)
);
create index repairs_client on public.repairs (client_id, requested_at desc);
-- Service-history lookups: "everything we've done to building #11640".
create index repairs_serial on public.repairs (client_id, serial) where serial is not null;
alter table public.repairs enable row level security;
create policy repairs_owner_select on public.repairs
  for select to authenticated using (client_id = current_client_id());

-- Per-tenant repair number, #101 up — same advisory-lock pattern as orders_assign_no()
-- (max()+1 under pg_advisory_xact_lock, so two simultaneous intakes can't collide).
create function public.repairs_assign_no()
returns trigger
language plpgsql
set search_path to 'public'
as $$
begin
  perform pg_advisory_xact_lock(hashtext('ss_repair_no:' || new.client_id));
  select coalesce(max(repair_no), 100) + 1 into new.repair_no
    from public.repairs where client_id = new.client_id;
  return new;
end;
$$;
create trigger repairs_assign_no_trg
  before insert on public.repairs
  for each row when (new.repair_no is null or new.repair_no = 0)
  execute function public.repairs_assign_no();

-- Now that repairs exists, give 087's build_jobs.repair_id its FK: deleting a repair
-- removes its shop card (portal-schedule cleans stops + photos in the same action).
alter table public.build_jobs
  add constraint build_jobs_repair_fk
  foreign key (repair_id) references public.repairs(id) on delete cascade;

-- ── Photo bucket ──────────────────────────────────────────────────────────────
-- PRIVATE, same posture as feedback-attachments (054): a repair photo shows a customer's
-- property. Paths are {client_id}/{repair_id}/{uuid}-{filename}. Uploads go ONLY through
-- portal-schedule (service role) — deliberately no INSERT policy for browser roles. The
-- portal displays photos via short-lived signed URLs, so the tenant-read policy below is
-- a convenience for direct rendering, scoped by the leading path segment.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'repair-photos', 'repair-photos', false, 26214400,   -- 25 MB
  array['image/png','image/jpeg','image/gif','image/webp']
)
on conflict (id) do update
  set public = false,
      file_size_limit = excluded.file_size_limit,
      allowed_mime_types = excluded.allowed_mime_types;

drop policy if exists repair_photos_tenant_read on storage.objects;
create policy repair_photos_tenant_read on storage.objects
  for select to authenticated using (
    bucket_id = 'repair-photos'
    and (storage.foldername(name))[1] = public.current_client_id()
  );

-- Rollback:
--   drop policy repair_photos_tenant_read on storage.objects;
--   delete from storage.buckets where id = 'repair-photos';
--   alter table public.build_jobs drop constraint build_jobs_repair_fk;
--   drop trigger repairs_assign_no_trg on public.repairs;
--   drop function public.repairs_assign_no();
--   drop table public.repairs;
