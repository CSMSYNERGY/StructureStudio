-- 022_size_inclusions: which layout options are INCLUDED (free) with each
-- building size. Drives the designer's "Included vs Additional" grouping and is
-- populated by the pricing+inclusion CSV import. One row per (size, item_key)
-- that is included; absence of a row ⇒ that item is an additional (charged)
-- option for that size. `qty` is reserved for the deferred "2 free lofts on an
-- 8x20" nuance — the UI uses `included` only for now.
--
-- Hand-applied via MCP execute_sql (NOT db push, NOT recorded in
-- supabase_migrations) to match 016–021. Mark applied during Task 2 reconcile.

create table if not exists public.building_size_inclusions (
  client_id  text not null,
  size_id    uuid not null references public.building_sizes(id) on delete cascade,
  item_key   text not null references public.layout_item_types(item_key),
  included   boolean not null default true,
  qty        int not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (size_id, item_key)
);

create index if not exists building_size_inclusions_client_idx
  on public.building_size_inclusions (client_id);

drop trigger if exists building_size_inclusions_set_updated_at on public.building_size_inclusions;
create trigger building_size_inclusions_set_updated_at
  before update on public.building_size_inclusions
  for each row execute function public.set_updated_at();
