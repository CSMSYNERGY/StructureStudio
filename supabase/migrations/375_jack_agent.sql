-- 375_jack_agent.sql -- Jack, the AI agent inside StructureStudio (plan: the vault's
-- StructureStudio AI Agent Plan 2026-11-02, version 1). Ships DARK: client_settings.jack_on is off for
-- every builder until someone turns it on, and the portal shows nothing while it is off.
--
-- APPLY BY HAND, AFTER A HUMAN HAS READ IT. Re-read the ledger first and take the next free number:
--     select max(version) from supabase_migrations.schema_migrations where version ~ '^\d{3}$';
--   Run this file as ONE statement batch (the Supabase connector's execute_sql, or stdin to
--   `supabase db query --linked`; NOT `--file`, see 270's header), then record it:
--     insert into supabase_migrations.schema_migrations (version, name) values ('375', '375_jack_agent') returning version;
--   Zero rows back from `returning` means the number was taken: renumber. NEVER `supabase db push`.
--   Before applying, diff area_level_for against live, because the part below re-issues it:
--     select pg_get_functiondef('public.area_level_for(text,text,jsonb,text)'::regprocedure);
--
-- WHAT THIS ADDS
--   client_settings.jack_on    the per-builder switch. Off by default; an operator turns it on by SQL.
--   client_settings.jack_off   what a builder's owner or admin switched off on the Jack tab, a list of
--                              switch names (Ahsan and Carolyn, 11-04 call, 20:19).
--   jack_conversations         one chat. Who, where it stands, running token and cost totals.
--   jack_messages              its turns: the words, the NAMES of the tools used, tokens and cost.
--                              `tools` can also hold '#repeated_customer_words' on an answer that
--                              repeated a customer's words (jack-agent agent.ts REPEATED_WORDS_MARK):
--                              the next turn starts with the customer-words lock on. No tool name
--                              can hold "#", so the mark is never mistaken for a tool.
--   jack_proposals             one thing Jack offers to do. It holds EXACTLY what was shown (preview,
--                              payload, shown_hash), who approved it, what happened per size (result)
--                              and how to put it back (undo). The button is the approval: nothing here
--                              runs until a person presses Approve, and the server runs only what
--                              this row holds. An unused one expires after 24 hours.
--   jack_usage()               the numbers the caps read.
--   area_level_for             re-issued with the new `jack` area (access.ts): owners and admins by
--                              preset, everyone else omitted, so it is off for them until an owner or
--                              admin ticks it on the Team screen.
--
-- All three tables are SERVICE-ROLE ONLY, like support_conversations (340): RLS on, no policies, every
-- grant revoked. The browser reaches them only through the jack-agent edge function.

alter table public.client_settings add column if not exists jack_on boolean not null default false;
alter table public.client_settings add column if not exists jack_off jsonb not null default '[]'::jsonb;

create table if not exists public.jack_conversations (
  id                 uuid primary key default gen_random_uuid(),
  client_id          text not null,
  user_id            uuid not null,
  status             text not null default 'open' check (status in ('open', 'closed')),
  title              text check (title is null or char_length(title) <= 120),
  model              text,
  message_count      integer not null default 0,
  input_tokens       bigint  not null default 0,
  output_tokens      bigint  not null default 0,
  cache_read_tokens  bigint  not null default 0,
  cache_write_tokens bigint  not null default 0,
  cost_micros        bigint  not null default 0,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  last_message_at    timestamptz not null default now()
);
create index if not exists jack_conversations_person_idx
  on public.jack_conversations (client_id, user_id, last_message_at desc);

create table if not exists public.jack_proposals (
  id                 uuid primary key default gen_random_uuid(),
  client_id          text not null,
  user_id            uuid not null,
  conversation_id    uuid references public.jack_conversations(id) on delete set null,
  kind               text not null check (kind in ('price_sheet', 'size_rule', 'new_fixture')),
  status             text not null check (status in ('reading', 'needs_answers', 'ready', 'applying', 'applied',
                       'partly_applied', 'undoing', 'undone', 'cancelled', 'expired', 'failed')),
  title              text not null check (char_length(title) <= 200),
  file_name          text check (file_name is null or char_length(file_name) <= 200),
  source             jsonb not null default '{}'::jsonb,
  preview            jsonb not null default '{}'::jsonb,
  payload            jsonb not null default '{}'::jsonb,
  answers            jsonb not null default '{}'::jsonb,
  result             jsonb,
  undo               jsonb,
  shown_hash         text,
  failure            text,
  model              text,
  input_tokens       bigint not null default 0,
  output_tokens      bigint not null default 0,
  cost_micros        bigint not null default 0,
  approved_by        uuid,
  approved_by_operator text,
  approved_at        timestamptz,
  applied_at         timestamptz,
  undone_by          uuid,
  undone_at          timestamptz,
  expires_at         timestamptz not null default now() + interval '24 hours',
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now()
);
create index if not exists jack_proposals_client_idx on public.jack_proposals (client_id, created_at desc);
create index if not exists jack_proposals_created_idx on public.jack_proposals (created_at);

create table if not exists public.jack_messages (
  id                 uuid primary key default gen_random_uuid(),
  conversation_id    uuid not null references public.jack_conversations(id) on delete cascade,
  client_id          text not null,
  user_id            uuid not null,
  role               text not null check (role in ('user', 'assistant')),
  body               text not null check (char_length(body) <= 8000),
  tools              text[] not null default '{}',
  proposal_ids       uuid[] not null default '{}',
  input_tokens       integer,
  output_tokens      integer,
  cache_read_tokens  integer,
  cache_write_tokens integer,
  cost_micros        bigint not null default 0,
  stop_reason        text,
  model              text,
  created_at         timestamptz not null default now()
);
create index if not exists jack_messages_conversation_idx on public.jack_messages (conversation_id, created_at);
create index if not exists jack_messages_client_idx on public.jack_messages (client_id, created_at desc);
create index if not exists jack_messages_user_idx on public.jack_messages (user_id, created_at desc);
create index if not exists jack_messages_created_idx on public.jack_messages (created_at);

alter table public.jack_conversations enable row level security;
alter table public.jack_messages      enable row level security;
alter table public.jack_proposals     enable row level security;
revoke all on public.jack_conversations from public, anon, authenticated;
revoke all on public.jack_messages      from public, anon, authenticated;
revoke all on public.jack_proposals     from public, anon, authenticated;
grant all on public.jack_conversations to service_role;
grant all on public.jack_messages      to service_role;
grant all on public.jack_proposals     to service_role;

-- month_cost_micros is every builder's together, because the workspace limit is one number.
create or replace function public.jack_usage(p_client_id text, p_user_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  select jsonb_build_object(
    'month_cost_micros',
      coalesce((select sum(cost_micros) from public.jack_messages
                 where created_at >= date_trunc('month', now() at time zone 'utc') at time zone 'utc'), 0)
      + coalesce((select sum(cost_micros) from public.jack_proposals
                 where created_at >= date_trunc('month', now() at time zone 'utc') at time zone 'utc'), 0),
    'tenant_24h', (select count(*) from public.jack_messages
                    where client_id = p_client_id and role = 'user' and created_at >= now() - interval '24 hours'),
    'user_10m', (select count(*) from public.jack_messages
                  where user_id = p_user_id and role = 'user' and created_at >= now() - interval '10 minutes'),
    'sheets_24h', (select count(*) from public.jack_proposals
                    where client_id = p_client_id and kind = 'price_sheet' and created_at >= now() - interval '24 hours')
  )
$$;
revoke all on function public.jack_usage(text, uuid) from public, anon, authenticated;
grant execute on function public.jack_usage(text, uuid) to service_role;

-- The `jack` area. Everything below is 326's function with three lines added: the area, and the
-- owner's and admin's preset cells. No other cell moved.
create or replace function public.area_level_for(
  p_role   text,
  p_title  text,
  p_access jsonb,
  p_area   text
) returns text
language plpgsql
immutable
set search_path = ''
as $fn$
declare
  -- ── AREAS ── mirror of `AREAS` in _shared/access.ts. `levels` is the vocabulary for THAT
  -- row: commissions, contacts, phone and change_order_approve are deliberately not the
  -- universal none/view/edit triplet, which is why the level check below reads the array
  -- instead of assuming three.
  --
  -- `internalOnly` is NOT mirrored, on purpose. It governs which switches accessMetadata()
  -- ships to a browser — a presentation rule with no bearing on how a stored map resolves —
  -- and mirroring it here would invite a future reader to treat it as the tenancy check,
  -- which it is not.
  -- 286: contacts gained own_view (own customers, view only), narrowest first after none.
  -- 326: meetings. 'own' = my calendar and my bookings; 'view' = the team's; 'edit' = manage
  --      anyone's and edit the tenant's meeting types. ownWrites in access.ts, so 'own' WRITES
  --      (your own hours are yours to set) — the same shape contacts:'own' has.
  -- 375: jack, the AI agent's tab. Owners and admins by preset, everyone else omitted.
  k_areas constant jsonb := $j$
  {
    "designer":              {"levels": ["none","view","edit"]},
    "price_override":        {"levels": ["none","edit"]},
    "jack":                  {"levels": ["none","edit"]},
    "designs":               {"levels": ["none","view","edit"]},
    "contacts":              {"levels": ["none","own_view","own","view","edit"]},
    "inventory":             {"levels": ["none","view","edit"]},
    "orders":                {"levels": ["none","view","edit"]},
    "change_orders":         {"levels": ["none","view","edit"]},
    "change_order_approve":  {"levels": ["none","edit"]},
    "build_schedule":        {"levels": ["none","view","edit"]},
    "delivery_schedule":     {"levels": ["none","view","edit"]},
    "repairs":               {"levels": ["none","view","edit"]},
    "commissions":           {"levels": ["none","own","edit"]},
    "reports":               {"levels": ["none","view","edit"]},
    "meetings":              {"levels": ["none","own","view","edit"]},
    "phone":                 {"levels": ["none","own","view","edit"]},
    "projects":              {"levels": ["none","view","edit"]},
    "settings_structures":   {"levels": ["none","view","edit"]},
    "settings_options":      {"levels": ["none","view","edit"]},
    "settings_branding":     {"levels": ["none","view","edit"]},
    "settings_crm":          {"levels": ["none","view","edit"]},
    "settings_quickbooks":   {"levels": ["none","view","edit"]},
    "settings_email":        {"levels": ["none","view","edit"]},
    "settings_team":         {"levels": ["none","view","edit"], "byTitleOnly": true},
    "settings_billing":      {"levels": ["none","view","edit"], "ownerGranted": true}
  }
  $j$::jsonb;

  -- ── PRESETS ── mirror of `PRESETS`. A title's default switches; anything a preset OMITS
  -- resolves to 'none', which is what makes tomorrow's new area safe to add.
  --
  -- ⚠️ THE CELLS 254 ADDED: phone. owner and admin edit; office_staff and sales_manager view;
  -- sales_rep and dealer own. scheduler, crew_leader, crew_member and driver OMIT it and
  -- therefore deny it. No other cell moved.
  k_presets constant jsonb := $j$
  {
    "owner": {
      "designer":"edit","designs":"edit","contacts":"edit","inventory":"edit","orders":"edit",
      "price_override":"edit","jack":"edit",
      "change_orders":"edit","change_order_approve":"edit",
      "build_schedule":"edit","delivery_schedule":"edit","repairs":"edit","commissions":"edit",
      "reports":"edit","meetings":"edit","phone":"edit","projects":"edit","settings_structures":"edit","settings_options":"edit",
      "settings_branding":"edit","settings_crm":"edit","settings_quickbooks":"edit",
      "settings_email":"edit","settings_team":"edit","settings_billing":"edit"
    },
    "admin": {
      "designer":"edit","designs":"edit","contacts":"edit","inventory":"edit","orders":"edit",
      "price_override":"edit","jack":"edit",
      "change_orders":"edit","change_order_approve":"edit",
      "build_schedule":"edit","delivery_schedule":"edit","repairs":"edit","commissions":"edit",
      "reports":"edit","meetings":"edit","phone":"edit","settings_structures":"edit","settings_options":"edit",
      "settings_branding":"edit","settings_crm":"edit","settings_quickbooks":"edit",
      "settings_email":"edit","settings_team":"edit","settings_billing":"none"
    },
    "sales_rep": {
      "designer":"edit","designs":"edit","contacts":"edit","phone":"own",
      "inventory":"view","orders":"edit","commissions":"own","meetings":"own"
    },
    "office_staff": {
      "designer":"edit",
      "designs":"edit","contacts":"edit","inventory":"edit","orders":"edit",
      "change_orders":"edit",
      "build_schedule":"view","delivery_schedule":"view","repairs":"view","reports":"view","meetings":"edit",
      "phone":"view",
      "settings_branding":"edit","settings_quickbooks":"edit"
    },
    "sales_manager": {
      "designer":"edit","designs":"edit","contacts":"edit","inventory":"view",
      "orders":"edit","change_orders":"edit","commissions":"edit","reports":"edit","meetings":"edit",
      "phone":"view"
    },
    "dealer": {
      "designer":"edit","designs":"edit","contacts":"own",
      "inventory":"view","orders":"edit","commissions":"own","phone":"own","meetings":"own"
    },
    "scheduler": {
      "build_schedule":"edit","delivery_schedule":"edit","repairs":"edit",
      "designs":"view","contacts":"view","inventory":"view","orders":"view"
    },
    "crew_leader": {
      "build_schedule":"edit","repairs":"edit",
      "designs":"view","inventory":"view","orders":"view"
    },
    "crew_member": {
      "build_schedule":"view","repairs":"view"
    },
    "driver": {
      "delivery_schedule":"edit",
      "inventory":"view","orders":"view"
    }
  }
  $j$::jsonb;

  v_area     jsonb;
  v_title    text;
  v_level    text;
  v_override text;
begin
  -- UNKNOWN AREA -> 'none'. Mirrored from 154 rather than quietly improved, because the two
  -- must agree; see that migration's note on why failing open here was rejected.
  v_area := k_areas -> p_area;
  if v_area is null then
    return 'none';
  end if;

  -- OWNERS ABSOLUTE. An owner's stored map is never consulted, so a hostile, corrupted or
  -- hand-edited access blob can never lock an owner out of their own business.
  --
  -- ⚠️ THIS LINE IS WHY NOTHING BELOW RE-CHECKS THE ROLE. crm_contact_scope() asks this
  -- function for the contacts level and compares it to 'own'; an owner can never produce
  -- that string, so owners are absolute in the RLS layer for free — by construction rather
  -- than by a second test somebody could forget to copy into the next policy.
  --
  -- It also returns the literal 'edit', which is exactly why change_order_approve is a
  -- two-level area topping out at 'edit' and not a third level named 'approve' — see the
  -- header.
  if p_role = 'owner' then
    return 'edit';
  end if;

  -- normTitle(): anything that is not one of the TEN known titles is a sales_rep.
  v_title := case
               when p_title in ('owner','admin','office_staff','sales_manager','sales_rep',
                               'dealer','scheduler','crew_leader','crew_member','driver')
                 then p_title
               else 'sales_rep'
             end;

  -- `out[k] = base[k] ?? "none"`.
  v_level := coalesce(k_presets -> v_title ->> p_area, 'none');

  -- The stored deviations, layered on top — the same three skips, in the same order as the
  -- TypeScript loop.
  if p_access is not null and jsonb_typeof(p_access) = 'object' then
    v_override := p_access ->> p_area;
    if v_override is not null
       and not (coalesce((v_area ->> 'ownerGranted')::boolean, false) and v_title <> 'admin')
       and not coalesce((v_area ->> 'byTitleOnly')::boolean, false)
       and exists (select 1 from jsonb_array_elements_text(v_area -> 'levels') as lv(l)
                    where lv.l = v_override)
    then
      v_level := v_override;
    end if;
  end if;

  return v_level;
end
$fn$;

-- Refuses a half-applied state, and proves the area resolves the way access.ts says it does.
do $$
begin
  if public.area_level_for('admin', 'admin', '{}'::jsonb, 'jack') <> 'edit' then
    raise exception '375: an admin should hold jack by preset';
  end if;
  if public.area_level_for('user', 'sales_rep', '{}'::jsonb, 'jack') <> 'none' then
    raise exception '375: a sales rep should not hold jack by preset';
  end if;
  if public.area_level_for('user', 'sales_rep', '{"jack":"edit"}'::jsonb, 'jack') <> 'edit' then
    raise exception '375: an owner should be able to tick jack on for a rep';
  end if;
  if public.area_level_for('user', 'sales_rep', '{}'::jsonb, 'meetings') <> 'own' then
    raise exception '375: the re-issue changed an area it should not have';
  end if;
end $$;
