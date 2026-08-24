-- 116_door_window_colors: colors for doors and windows.
--
-- Doors (mostly barn doors) paint in the client's existing paint scheme, so the
-- colors table gains a `door` category flag (same pattern as 038's shingle/metal)
-- plus `door_rate` — a FLAT dollar amount per door, deliberately separate from the
-- paint `rate` (which runs through pricing_method): painting one door in Barn Red
-- costs $50 even when Barn Red siding is $1.50/sq ft.
--
-- Each catalog door then declares HOW it colors via fixture_items.color_mode:
--   'fixed'  one color only, no customer picker (default — matches today's behavior;
--            fixed_color_id NULL means "no color", i.e. the hard-coded 3D brown)
--   'paint'  customer picks from door-flagged colors
--   'match'  like paint, but the picker DEFAULTS to the building's chosen body/trim
--            colors; the customer can still change either
-- has_trim_color adds a second (trim) color pick for two-tone barn doors.
--
-- Windows get their own small per-client list (White/Black/Beige/Clay...) in a new
-- window_colors table rather than a flag on colors, because (a) colors has
-- unique(client_id,label) and nearly every tenant wants window "White" alongside
-- paint "White", (b) a window color's rate is a flat per-window dollar, not the
-- pricing_method engine, and (c) the Colors tab derives its sections from the flag
-- combinations — a fourth pseudo-category would disturb every filter for a 6-column
-- list. Every active window fixture offers every active window color, so builders
-- never duplicate a window row per color.

-- ── colors: door category + flat per-door price ─────────────────────────────
alter table public.colors add column if not exists door boolean not null default false;
alter table public.colors add column if not exists door_rate numeric not null default 0;

-- A color must be usable in at least one category (widened from 038).
alter table public.colors drop constraint if exists colors_usable_somewhere;
alter table public.colors add constraint colors_usable_somewhere
  check (siding or trim or shingle or metal or door);

-- ── fixture_items: per-door color behavior ──────────────────────────────────
alter table public.fixture_items add column if not exists color_mode text not null default 'fixed';
alter table public.fixture_items drop constraint if exists fixture_items_color_mode_check;
alter table public.fixture_items add constraint fixture_items_color_mode_check
  check (color_mode in ('paint','fixed','match'));
alter table public.fixture_items add column if not exists has_trim_color boolean not null default false;
-- on delete set null: deleting a palette row degrades a fixed-mode door back to
-- "no color" (today's rendering) instead of blocking the delete.
alter table public.fixture_items add column if not exists fixed_color_id uuid
  references public.colors(id) on delete set null;

-- ── window_colors: small per-client list ────────────────────────────────────
create table if not exists public.window_colors (
  id          uuid primary key default gen_random_uuid(),
  client_id   text not null,
  label       text not null,
  hex         text,                                 -- '#RRGGBB' swatch
  rate        numeric not null default 0,           -- flat $ per window; 0 = included
  is_default  boolean not null default false,       -- preselected in the picker
  sort_order  int not null default 0,
  active      boolean not null default true,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  unique (client_id, label)
);

create index if not exists window_colors_client_idx on public.window_colors (client_id, sort_order);

drop trigger if exists window_colors_set_updated_at on public.window_colors;
create trigger window_colors_set_updated_at before update on public.window_colors
  for each row execute function public.set_updated_at();

-- Same posture as fixture_items (064) + the 102/112 convention: owner-scoped
-- authenticated read, explicit anon revoke, writes via service role only (the
-- portal-settings edge function). The anon designer reads these through
-- get_fixtures (SECURITY DEFINER), never the table.
alter table public.window_colors enable row level security;

drop policy if exists window_colors_owner_read on public.window_colors;
create policy window_colors_owner_read on public.window_colors
  for select to authenticated using (client_id = public.current_client_id());

revoke all on table public.window_colors from anon;
revoke insert, update, delete on table public.window_colors from authenticated;
