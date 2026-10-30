-- 340_support_agent.sql — the AI support assistant behind the top-bar Support button, and tickets.
--
-- ⛔ APPLY BY HAND, AFTER A HUMAN HAS READ IT. Re-read the ledger first and take the next free
--    number (339 was held for the library on 10-27):
--      select max(version) from supabase_migrations.schema_migrations where version ~ '^\d{3}$';
--    Run this file as ONE statement batch (the Supabase connector's execute_sql, or stdin to
--    `supabase db query --linked`; NOT `--file`, see 270's header), then record it:
--      insert into supabase_migrations.schema_migrations (version, name) values ('340', '340_support_agent') returning version, name;
--    Zero rows back from `returning` means the number was taken: renumber. NEVER `supabase db push`.
--    No begin;/commit; here (a multi-statement begin/commit block has applied nothing before with
--    no error); every statement is idempotent and the closing DO block refuses a half-applied state.
--
-- ── WHY (Carolyn, 10-26 call) ──────────────────────────────────────────────────────────────
-- "I would take this feedback button down at the below. We'll have a support button up here" and
-- an AI assistant that answers first, "really good, conversational", with a person following up
-- within about 24 hours. The roadmap item: "AI support chat agent trained on the product and on the
-- individual account". Nothing is trained: one product-wide assistant reads the signed-in builder's
-- own account through read-only tools when they ask (support-agent edge function).
--
-- ── WHAT THIS ADDS ──────────────────────────────────────────────────────────────────────────
--   support_conversations  one chat. Who (client_id, user_id), where it stands (open, handed_off
--                          when it became a ticket, closed), and running token and cost totals.
--   support_messages       its turns. The text the builder typed and the text the assistant
--                          answered, capped at 8,000 characters; the NAMES of the tools used (never
--                          their inputs or outputs); tokens, cost in micros (millionths of a
--                          dollar) and Claude's stop_reason.
--   feedback_submissions   kind 'ticket' beside bug and feature, and support_conversation_id, the
--                          chat a ticket was handed off from.
--   client_settings.support_ai_daily_cap   messages per tenant per rolling 24 h: NULL = the
--                          default (60), 0 = unlimited, n = that many. Service-role only, like
--                          ai_style_daily_cap (227): a tenant must not raise its own spend cap.
--   support_usage()        the three counts the edge function checks BEFORE it calls Claude.
--
-- ── TRUST BOUNDARY ─────────────────────────────────────────────────────────────────────────
-- Both tables are SERVICE-ROLE ONLY: RLS on, no policies, every grant revoked from public, anon
-- and authenticated (this project's default privileges make a NEW table world-readable through
-- the PUBLIC grant, which survives a revoke aimed only at anon/authenticated). The browser never
-- reads them: the portal asks support-agent, which scopes every read to the caller's own tenant
-- and user. A chat can hold a builder's own words about their customers, so it must never be one
-- RLS mistake away from another tenant.
--
-- ── RETENTION (Ahsan, 10-27) ───────────────────────────────────────────────────────────────
-- 180 days idle, then deleted by support-agent itself (there is no pg_cron on this project).
-- The team may read chats that never became tickets; the chat panel says chats are saved.
--
-- The repo is public: no client identifiers or alert addresses in here. The alert inbox lives in
-- the SUPPORT_NOTIFY_TO secret.
--
-- ROLLBACK (only before any ticket or chat exists that anyone needs):
--   alter table public.feedback_submissions drop column if exists support_conversation_id;
--   delete from public.feedback_submissions where kind = 'ticket';
--   alter table public.feedback_submissions drop constraint if exists feedback_submissions_kind_check;
--   alter table public.feedback_submissions add constraint feedback_submissions_kind_check check (kind in ('bug','feature'));
--   drop function if exists public.support_usage(text, uuid);
--   drop table if exists public.support_messages;
--   drop table if exists public.support_conversations;
--   alter table public.client_settings drop column if exists support_ai_daily_cap;

-- ── Conversations ──────────────────────────────────────────────────────────────────────────
create table if not exists public.support_conversations (
  id                 uuid primary key default gen_random_uuid(),
  client_id          text not null,
  user_id            uuid not null,                 -- the builder's login that chatted (auth.users id)
  status             text not null default 'open'
                       check (status in ('open', 'handed_off', 'closed')),
  -- The ticket this chat became, when it became one. Set null if that ticket is deleted.
  submission_id      uuid references public.feedback_submissions(id) on delete set null,
  model              text,                          -- the model that answered last
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

create index if not exists support_conversations_client_idx
  on public.support_conversations (client_id, created_at desc);
-- "This person's live chat": one open conversation per user, newest first.
create index if not exists support_conversations_user_idx
  on public.support_conversations (user_id, last_message_at desc);
-- The 180-day retention sweep.
create index if not exists support_conversations_idle_idx
  on public.support_conversations (last_message_at);

-- ── Messages ───────────────────────────────────────────────────────────────────────────────
create table if not exists public.support_messages (
  id                 uuid primary key default gen_random_uuid(),
  conversation_id    uuid not null references public.support_conversations(id) on delete cascade,
  client_id          text not null,                 -- denormalised: the tenant's daily cap counts these
  user_id            uuid not null,                 -- denormalised: the per-user 10-minute cap counts these
  role               text not null check (role in ('user', 'assistant')),
  body               text not null check (char_length(body) <= 8000),
  tools              text[] not null default '{}',  -- tool NAMES only, never inputs or outputs
  input_tokens       integer,
  output_tokens      integer,
  cache_read_tokens  integer,
  cache_write_tokens integer,
  cost_micros        bigint not null default 0,
  stop_reason        text,
  model              text,
  created_at         timestamptz not null default now()
);

create index if not exists support_messages_conversation_idx
  on public.support_messages (conversation_id, created_at);
create index if not exists support_messages_client_idx
  on public.support_messages (client_id, created_at desc);
create index if not exists support_messages_user_idx
  on public.support_messages (user_id, created_at desc);
-- The monthly ceiling sums cost across every tenant for the calendar month.
create index if not exists support_messages_created_idx
  on public.support_messages (created_at);

-- ── Service-role only ──────────────────────────────────────────────────────────────────────
alter table public.support_conversations enable row level security;
alter table public.support_messages      enable row level security;
revoke all on public.support_conversations from public, anon, authenticated;
revoke all on public.support_messages      from public, anon, authenticated;
grant all on public.support_conversations to service_role;
grant all on public.support_messages      to service_role;

-- ── Tickets ────────────────────────────────────────────────────────────────────────────────
-- 054 named its inline check feedback_submissions_kind_check (verified live 10-27). Bug and
-- feature keep exactly the meaning they had; 'ticket' is the "Submit a ticket" entry and the
-- assistant's hand-off. RLS on feedback_submissions is unchanged, so a builder reads their own
-- tickets in My Requests the same way they read their bugs.
alter table public.feedback_submissions drop constraint if exists feedback_submissions_kind_check;
alter table public.feedback_submissions
  add constraint feedback_submissions_kind_check check (kind in ('bug', 'feature', 'ticket'));

alter table public.feedback_submissions
  add column if not exists support_conversation_id uuid
    references public.support_conversations(id) on delete set null;

-- ── The tenant's daily cap ────────────────────────────────────────────────────────────────
alter table public.client_settings
  add column if not exists support_ai_daily_cap integer;

comment on column public.client_settings.support_ai_daily_cap is
  'Support assistant messages allowed per tenant per rolling 24h. NULL = the built-in default (60); '
  '0 = unlimited; n = that many. Service-role only, like ai_style_daily_cap (227): a tenant must not '
  'raise its own spend cap. The monthly ceiling across all tenants is the SUPPORT_AI_MONTHLY_CAP_USD secret.';

-- Our own accounts are unlimited: the internal flag (169), never a slug.
update public.client_settings set support_ai_daily_cap = 0
  where internal_account = true and support_ai_daily_cap is null;

-- ── The counts support-agent checks before it calls Claude ────────────────────────────────
-- One round trip for three numbers. Only the builder's own messages count toward the caps (an
-- assistant reply is not something they asked for twice); the month's cost counts everything.
create or replace function public.support_usage(p_client_id text, p_user_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  select jsonb_build_object(
    'month_cost_micros', coalesce((
      select sum(cost_micros) from public.support_messages
      where created_at >= date_trunc('month', now() at time zone 'utc') at time zone 'utc'), 0),
    'tenant_24h', (
      select count(*) from public.support_messages
      where client_id = p_client_id and role = 'user' and created_at >= now() - interval '24 hours'),
    'user_10m', (
      select count(*) from public.support_messages
      where user_id = p_user_id and role = 'user' and created_at >= now() - interval '10 minutes')
  )
$$;

revoke all on function public.support_usage(text, uuid) from public, anon, authenticated;
grant execute on function public.support_usage(text, uuid) to service_role;

-- ── Refuse a half-applied state ───────────────────────────────────────────────────────────
-- A missing column fails SILENTLY in the edge function (the select errors, the code falls back),
-- so every piece is checked here and the batch aborts if any one did not land.
do $m340$
declare
  missing text := '';
  def text;
begin
  if to_regclass('public.support_conversations') is null then missing := missing || ' support_conversations'; end if;
  if to_regclass('public.support_messages') is null then missing := missing || ' support_messages'; end if;
  if not exists (select 1 from information_schema.columns where table_schema = 'public'
      and table_name = 'feedback_submissions' and column_name = 'support_conversation_id') then
    missing := missing || ' feedback_submissions.support_conversation_id';
  end if;
  if not exists (select 1 from information_schema.columns where table_schema = 'public'
      and table_name = 'client_settings' and column_name = 'support_ai_daily_cap') then
    missing := missing || ' client_settings.support_ai_daily_cap';
  end if;
  if to_regprocedure('public.support_usage(text, uuid)') is null then missing := missing || ' support_usage()'; end if;
  select pg_get_constraintdef(oid) into def from pg_constraint
    where conrelid = 'public.feedback_submissions'::regclass and conname = 'feedback_submissions_kind_check';
  if def is null or position('ticket' in def) = 0 or position('bug' in def) = 0 or position('feature' in def) = 0 then
    missing := missing || ' kind_check(bug,feature,ticket)';
  end if;
  if exists (select 1 from pg_policies where schemaname = 'public'
      and tablename in ('support_conversations', 'support_messages')) then
    missing := missing || ' (a policy exists on a support table)';
  end if;
  if has_table_privilege('anon', 'public.support_messages', 'select')
     or has_table_privilege('authenticated', 'public.support_messages', 'select')
     or has_table_privilege('anon', 'public.support_conversations', 'select')
     or has_table_privilege('authenticated', 'public.support_conversations', 'select') then
    missing := missing || ' (a browser role can read a support table)';
  end if;
  if has_function_privilege('anon', 'public.support_usage(text, uuid)', 'execute')
     or has_function_privilege('authenticated', 'public.support_usage(text, uuid)', 'execute') then
    missing := missing || ' (a browser role can run support_usage)';
  end if;
  if missing <> '' then
    raise exception '340 did not apply cleanly:%', missing;
  end if;
end
$m340$;
