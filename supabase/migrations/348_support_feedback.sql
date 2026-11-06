-- 348_support_feedback.sql — 👍/👎 on the Studio Assistant's answers, and its "didn't know" notes.
--
-- ⛔ APPLY BY HAND, AFTER A HUMAN HAS READ IT. Either the Supabase connector's apply_migration
--    (name '348_support_feedback'; it stamps its own timestamp version, so add no second row), or
--    the connector's execute_sql followed by the ledger row:
--      insert into supabase_migrations.schema_migrations (version, name) values ('348', '348_support_feedback') returning version, name;
--    Zero rows back from `returning` means the number was taken: renumber this file, its test
--    (tests/sql/migration348.test.cjs) and every '348' below. NEVER `supabase db push`, never
--    `db query --file`. The file carries its own begin;/commit;; READ IT BACK afterwards in a
--    separate query (a printed record is not proof, 346's header):
--      select table_name, column_name, data_type from information_schema.columns
--       where table_schema = 'public' and table_name in ('support_messages', 'support_conversations')
--         and column_name in ('rating', 'rating_note', 'rated_at', 'gap', 'up_count', 'down_count', 'gap_count');
--
-- ── WHY (Carolyn, 10-27 call; Ahsan 10-30: "it is just for tracking purpose") ─────────────
-- "I want you, when you're setting this up, to where we see how it's responding, how the users are
-- responding, and what we need to improve." Admin → Support chats (9724a1f6) shows every chat; this
-- adds what the builders and the assistant say about the answers.
--
-- ── WHAT THIS ADDS ──────────────────────────────────────────────────────────────────────────
--   support_messages.rating       1 (👍) or -1 (👎) from the builder who asked; NULL = not rated.
--                                 Answers only (role 'assistant').
--   support_messages.rating_note  the optional "What was wrong?" line under a 👎, at most 300 chars.
--   support_messages.rated_at     when the rating last changed.
--   support_messages.gap          the assistant's own "didn't know" note (its note_gap tool): the
--                                 question it could not answer, in a few words, at most 300 chars.
--                                 Answers only. Builders never see it.
--   support_conversations.up_count / down_count / gap_count
--                                 the chat's tallies, kept by a trigger (a recount on every change,
--                                 never an increment), so Admin → Support chats filters "👎 only" and
--                                 "Didn't know" on the chat itself.
--
-- ── TRUST BOUNDARY: UNCHANGED ───────────────────────────────────────────────────────────────
-- Both tables stay service-role only (340): RLS on, no policy, nothing for the browser roles. New
-- columns inherit that. A builder rates through support-agent's `rate` action, which updates only
-- an answer in the caller's own chat (client_id AND user_id AND role 'assistant'); an operator
-- reads through admin-catalog. The checks below refuse a table that has drifted from that.
--
-- ── SAFE WITH WHAT IS LIVE ──────────────────────────────────────────────────────────────────
-- ADD COLUMN with no default (or a constant default) is a catalog change; both tables hold a few
-- dozen rows. The live support-agent (346.2) and admin-catalog (v145) name none of these columns,
-- so nothing changes until the new builds deploy. ⚠️ ORDER: apply this FIRST, then deploy
-- support-agent 348.1 and admin-catalog: both select the new columns and would fail without them.
--
-- ── ROLLBACK (deploy the previous support-agent and admin-catalog first) ────────────────────
--   drop trigger if exists support_messages_tally_ins on public.support_messages;
--   drop trigger if exists support_messages_tally_upd on public.support_messages;
--   drop function if exists public.support_message_tally();
--   alter table public.support_messages drop constraint if exists support_messages_rating_on_answers;
--   alter table public.support_messages drop constraint if exists support_messages_gap_on_answers;
--   alter table public.support_messages drop column if exists rating, drop column if exists rating_note,
--     drop column if exists rated_at, drop column if exists gap;
--   alter table public.support_conversations drop column if exists up_count, drop column if exists down_count,
--     drop column if exists gap_count;
--   delete from supabase_migrations.schema_migrations where version = '348';
--   notify pgrst, 'reload schema';

begin;

-- support-agent writes support_messages on every answer; a hung apply gives up rather than queue them.
set local lock_timeout = '5s';

do $m348_pre$
begin
  if to_regclass('public.support_messages') is null or to_regclass('public.support_conversations') is null then
    raise exception '348: the support tables are missing — apply 340 first';
  end if;
end
$m348_pre$;

alter table public.support_messages
  add column if not exists rating      smallint check (rating in (-1, 1)),
  add column if not exists rating_note text check (char_length(rating_note) <= 300),
  add column if not exists rated_at    timestamptz,
  add column if not exists gap         text check (char_length(gap) <= 300);

alter table public.support_conversations
  add column if not exists up_count   integer not null default 0,
  add column if not exists down_count integer not null default 0,
  add column if not exists gap_count  integer not null default 0;

-- A builder rates an answer, never their own words; only the assistant writes a gap note.
do $m348_checks$
begin
  if not exists (select 1 from pg_constraint where conrelid = 'public.support_messages'::regclass and conname = 'support_messages_rating_on_answers') then
    alter table public.support_messages add constraint support_messages_rating_on_answers
      check ((rating is null and rating_note is null) or role = 'assistant');
  end if;
  if not exists (select 1 from pg_constraint where conrelid = 'public.support_messages'::regclass and conname = 'support_messages_gap_on_answers') then
    alter table public.support_messages add constraint support_messages_gap_on_answers
      check (gap is null or role = 'assistant');
  end if;
end
$m348_checks$;

-- ── The tallies ───────────────────────────────────────────────────────────────────────────
-- A recount of the one chat, so a 👍 changed to a 👎 (or cleared) can never drift the numbers.
create or replace function public.support_message_tally()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  update public.support_conversations c set
    up_count   = (select count(*) from public.support_messages m where m.conversation_id = new.conversation_id and m.rating = 1),
    down_count = (select count(*) from public.support_messages m where m.conversation_id = new.conversation_id and m.rating = -1),
    gap_count  = (select count(*) from public.support_messages m where m.conversation_id = new.conversation_id and m.gap is not null)
  where c.id = new.conversation_id;
  return null;
end
$$;

revoke all on function public.support_message_tally() from public, anon, authenticated;

drop trigger if exists support_messages_tally_ins on public.support_messages;
create trigger support_messages_tally_ins
  after insert on public.support_messages
  for each row when (new.rating is not null or new.gap is not null)
  execute function public.support_message_tally();

drop trigger if exists support_messages_tally_upd on public.support_messages;
create trigger support_messages_tally_upd
  after update of rating, gap on public.support_messages
  for each row when (old.rating is distinct from new.rating or old.gap is distinct from new.gap)
  execute function public.support_message_tally();

-- ── The checks (they RAISE and abort the whole file) ────────────────────────────────────────
do $m348_check$
declare
  missing text := '';
  v_col record;
begin
  for v_col in
    select * from (values
      ('support_messages', 'rating', 'smallint'),
      ('support_messages', 'rating_note', 'text'),
      ('support_messages', 'rated_at', 'timestamp with time zone'),
      ('support_messages', 'gap', 'text'),
      ('support_conversations', 'up_count', 'integer'),
      ('support_conversations', 'down_count', 'integer'),
      ('support_conversations', 'gap_count', 'integer')
    ) as w(t, c, ty)
  loop
    if not exists (select 1 from information_schema.columns i where i.table_schema = 'public'
        and i.table_name = v_col.t and i.column_name = v_col.c and i.data_type = v_col.ty) then
      missing := missing || format(' %s.%s(%s)', v_col.t, v_col.c, v_col.ty);
    end if;
  end loop;
  if (select count(*) from pg_trigger where tgrelid = 'public.support_messages'::regclass
        and tgname in ('support_messages_tally_ins', 'support_messages_tally_upd') and not tgisinternal) <> 2 then
    missing := missing || ' (the tally triggers)';
  end if;
  if (select count(*) from pg_constraint where conrelid = 'public.support_messages'::regclass
        and conname in ('support_messages_rating_on_answers', 'support_messages_gap_on_answers')) <> 2 then
    missing := missing || ' (the answers-only checks)';
  end if;
  -- Still service-role only (340).
  if exists (select 1 from pg_policies where schemaname = 'public'
      and tablename in ('support_conversations', 'support_messages')) then
    missing := missing || ' (a policy exists on a support table)';
  end if;
  if exists (select 1 from pg_roles where rolname = 'anon') and (
       has_table_privilege('anon', 'public.support_messages', 'select')
    or has_table_privilege('authenticated', 'public.support_messages', 'select')
    or has_table_privilege('anon', 'public.support_messages', 'update')
    or has_table_privilege('authenticated', 'public.support_messages', 'update')
    or has_table_privilege('anon', 'public.support_conversations', 'select')
    or has_table_privilege('authenticated', 'public.support_conversations', 'select')) then
    missing := missing || ' (a browser role can reach a support table)';
  end if;
  if missing <> '' then
    raise exception '348 did not apply cleanly:%', missing;
  end if;
end
$m348_check$;

notify pgrst, 'reload schema';

-- ── THE RECORD ────────────────────────────────────────────────────────────────────────────
-- PASS on a first apply: columns 7, triggers 2, rated 0, gaps 0; chats is however many exist.
select
  '348' as migration,
  (select count(*)::int from information_schema.columns where table_schema = 'public'
     and ((table_name = 'support_messages' and column_name in ('rating', 'rating_note', 'rated_at', 'gap'))
       or (table_name = 'support_conversations' and column_name in ('up_count', 'down_count', 'gap_count')))) as columns,
  (select count(*)::int from pg_trigger where tgrelid = 'public.support_messages'::regclass
     and tgname like 'support_messages_tally_%' and not tgisinternal) as triggers,
  (select count(*)::int from public.support_messages where rating is not null) as rated,
  (select count(*)::int from public.support_messages where gap is not null) as gaps,
  (select count(*)::int from public.support_conversations) as chats;

commit;
