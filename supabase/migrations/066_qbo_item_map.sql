-- 066_qbo_item_map.sql — which QuickBooks product/service each estimate line is billed as,
-- plus the plumbing the invoice push writes back into.
--
-- Renumbered from the planned 064 (taken by the fixtures catalog).

-- ── The mapping grid ─────────────────────────────────────────────────────────────────
-- One row per (line kind [, layout item key] [, style override]) → QuickBooks item.
--
-- `item_key` is NOT NULL DEFAULT '' rather than nullable on purpose: it lets two partial
-- unique indexes cover every shape instead of four, because '' compares normally while
-- NULL never equals NULL.
create table if not exists public.qbo_item_map (
  id            uuid primary key default gen_random_uuid(),
  client_id     text not null,

  -- Closed set. Anything outside it is a bug, not a new feature.
  line_kind     text not null check (line_kind in (
                  'building', 'paint', 'roof', 'layout_item',
                  'custom_option', 'discount', 'delivery', 'fallback')),

  -- Only layout_item lines fan out by key (one row per placeable item type).
  item_key      text not null default '',

  -- Per-style override. NULL = the tenant-wide default for this kind.
  style_id      uuid references public.building_styles(id) on delete cascade,

  qbo_item_id   text not null,
  qbo_item_name text,

  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),

  -- An item_key belongs to layout_item lines and nothing else, in both directions.
  constraint qbo_item_map_key_shape
    check ((line_kind = 'layout_item') = (item_key <> '')),

  -- Only these two kinds vary by style; a paint or delivery override is meaningless.
  constraint qbo_item_map_style_shape
    check (style_id is null or line_kind in ('building', 'layout_item'))
);

-- Two partial uniques, following the 010 model: defaults and overrides are distinct
-- keyspaces because a NULL style_id can't participate in a normal unique constraint.
create unique index if not exists qbo_item_map_default_uniq
  on public.qbo_item_map (client_id, line_kind, item_key)
  where style_id is null;

create unique index if not exists qbo_item_map_override_uniq
  on public.qbo_item_map (client_id, line_kind, item_key, style_id)
  where style_id is not null;

create index if not exists qbo_item_map_client_idx
  on public.qbo_item_map (client_id);

-- ── RLS: service-role only ───────────────────────────────────────────────────────────
-- The `invoice_sends` posture, chosen deliberately over an owner-readable policy: an
-- operator using view-as is NOT in the viewed tenant's `client_users`, so an RLS-shaped
-- read path would break this grid for exactly the person configuring it. Reads go
-- through portal-settings, which resolves the tenant server-side.
alter table public.qbo_item_map enable row level security;

-- ── Push plumbing ────────────────────────────────────────────────────────────────────
-- Written by the invoice push. Kept on invoice_sends so one ledger row tells the whole
-- story of an invoice: what GHL did, and what QuickBooks did.
alter table public.invoice_sends
  add column if not exists qbo_invoice_id text,
  add column if not exists qbo_doc_number text,
  add column if not exists qbo_pushed_at  timestamptz,
  add column if not exists qbo_error      text,
  add column if not exists qbo_attempts   integer not null default 0;

-- The line-by-line provenance of an estimate, captured by submit-estimate at the moment
-- the amounts are final. Without it the push would have to re-derive which catalog row
-- produced each line, which is not recoverable after the fact.
alter table public.designs
  add column if not exists estimate_lines jsonb;
