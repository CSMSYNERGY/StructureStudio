-- 087_scheduling_core: Build Schedule foundations — custom stages, build jobs, activity log.
--
-- Phase 1 of the Build/Delivery Scheduling + Repairs feature (SCHEDULING_SCOPE.md, mockup
-- approved by Carolyn 2026-08-04). Billing: everything ships behind the existing
-- `schedule_builds` feature — Repairs included, no new billing key (decision 12).
--
-- Shape decisions that live here:
--   * Stages are BUILD-board only and tenant-customizable (rename/recolor/reorder), but
--     every stage carries a machine-readable `kind` — automation keys on kind, NEVER on
--     the user-editable name (the Monday "Shipped"→"Completed" rename lesson).
--   * build_jobs snapshots customer/building/dimensions at creation. There is no detail
--     popout in the UI (decision 6): the row must carry everything it displays. Dimensions
--     (width_ft/length_ft) come from the design's own widthFt/heightFt and feed the
--     delivery deck-fit + wide-load math — computed, never hand-entered (decision 7).
--   * Order jobs mint their shop serial from take_next_serial() (075 reserved the shared
--     counter for exactly this). The RPC stays service-role-only; portal-schedule calls it.
--   * repair_id is a plain uuid here; its FK is added by 089_repairs (table order).
--   * schedule_activity is what makes crew-wide stage moves safe: every mutation is
--     attributable (who moved what, when, why — including delivery overrides later).
--
-- RLS posture (same as inventory_units): owner-scoped SELECT for authenticated, ZERO write
-- policies — all writes go through the portal-schedule edge function (service role) so
-- role gating, operator can_write, and audit apply. Do not add INSERT/UPDATE policies.

-- ── Build stages (per tenant, customizable) ──────────────────────────────────
create table public.schedule_stages (
  id uuid primary key default gen_random_uuid(),
  client_id text not null,
  name text not null,
  color text not null default '#94A3B8',
  -- queue = waiting to start · active = work in progress · done = finished.
  -- The delivery side asks ONE question of this table: "is this job's stage kind done?"
  kind text not null check (kind in ('queue','active','done')),
  sort_order integer not null default 0,
  archived boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index schedule_stages_client on public.schedule_stages (client_id, sort_order);
alter table public.schedule_stages enable row level security;
create policy schedule_stages_owner_select on public.schedule_stages
  for select to authenticated using (client_id = current_client_id());

-- ── Build jobs (one row per building/repair in the shop) ─────────────────────
create table public.build_jobs (
  id uuid primary key default gen_random_uuid(),
  client_id text not null,
  stage_id uuid not null references public.schedule_stages(id),
  -- Float ordering within a stage column; the function re-spaces on collision.
  position numeric not null default 0,
  source text not null check (source in ('order','inventory','repair','manual')),
  -- Soft link to designs (same no-FK convention as orders.short_code).
  design_short_code text,
  -- orders' own migration lives on wip/orders, so no FK (soft link, validated in the fn).
  order_id uuid,
  inventory_unit_id uuid references public.inventory_units(id) on delete set null,
  repair_id uuid,  -- FK added by 089_repairs
  serial bigint,
  title text,
  customer_name text,
  building_label text,
  width_ft numeric,
  length_ft numeric,
  scheduled_start date,
  due_date date,
  completed_at timestamptz,
  assignee_user_id uuid,
  notes text,
  created_by uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index build_jobs_client on public.build_jobs (client_id, stage_id, position);
-- One card per building — a duplicate insert dies here, not in application logic.
create unique index build_jobs_one_per_design on public.build_jobs (client_id, design_short_code)
  where design_short_code is not null;
create unique index build_jobs_one_per_unit on public.build_jobs (client_id, inventory_unit_id)
  where inventory_unit_id is not null;
create unique index build_jobs_one_per_repair on public.build_jobs (client_id, repair_id)
  where repair_id is not null;
alter table public.build_jobs enable row level security;
create policy build_jobs_owner_select on public.build_jobs
  for select to authenticated using (client_id = current_client_id());

-- ── Activity log (crew accountability + override trail) ─────────────────────
create table public.schedule_activity (
  id uuid primary key default gen_random_uuid(),
  client_id text not null,
  subject text not null check (subject in ('build_job','load','stop','repair')),
  subject_id uuid not null,
  user_id uuid,
  action text not null check (action in
    ('created','moved','dated','assigned','noted','completed','deleted',
     'loaded','unloaded','out','delivered','override','updated')),
  from_stage_id uuid,
  to_stage_id uuid,
  detail text,
  created_at timestamptz not null default now()
);
create index schedule_activity_subject on public.schedule_activity (client_id, subject, subject_id, created_at desc);
alter table public.schedule_activity enable row level security;
create policy schedule_activity_owner_select on public.schedule_activity
  for select to authenticated using (client_id = current_client_id());

-- Rollback:
--   drop table public.schedule_activity;
--   drop table public.build_jobs;
--   drop table public.schedule_stages;
