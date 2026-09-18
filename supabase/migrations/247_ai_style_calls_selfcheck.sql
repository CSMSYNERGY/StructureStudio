-- 247 — The self-check's own columns, and the ruler the builder typed.
--
-- WHY. 226 made a generation inspectable after the fact: what the model drafted, what it said it
-- saw, how many images it read. Two things happen after that draft which 226 has nowhere to put.
--
-- FIRST, the builder now types the building's width, length and wall height before pressing
-- Generate, and those three numbers are stated to the model as facts. They are the single
-- biggest change to what a generation reads, and without them on the row there is no way to
-- tell a draft that had a ruler from one that guessed. The tell people would otherwise reach
-- for — "the wall height came back a round number" — is not evidence: the model was not asked
-- for a wall height at all when dims are present, so a matching number proves only that the
-- server wrote the builder's own value back. `dims` records what was actually used.
--
-- SECOND, a second, FREE pass looks at the draft against renders of it and either says it
-- matches or hands back corrections. That pass has to be single-use — one paid row buys exactly
-- one check — and it has to be measurable afterwards, because "is the check earning its keep?"
-- is the question that decides whether it stays.
--
-- ⚠️ `drafted` KEEPS THE FIRST PASS. This is the load-bearing column decision here. The
-- corrected spec goes in `self_check_after`, never over `drafted`. If the check overwrote the
-- draft, every future question of the form "did the check help, or did it make a good draft
-- worse?" would become unanswerable from this table — which is the exact hole 226 was written
-- to close. Keeping both sides means the correction distribution across every tenant is one
-- diff query, with no harness and no corpus.
--
-- WHAT EACH COLUMN IS FOR.
--   dims                jsonb       {widthFt, lengthFt, wallHeightFt, overhangIn?} exactly as the
--                                   server USED them — null when the caller sent none, and null
--                                   when they arrived on a source with no dims prompt.
--   self_check_at       timestamptz THE CLAIM. Set by a conditional update that returns the row
--                                   only when it was still null, which is the whole anti-loop
--                                   mechanism: a second request for the same row gets no row and
--                                   is refused before any model call. Also the record that a
--                                   check ran at all.
--   self_check_verdict  text        matches | corrections | rejected_too_many | failed | skipped.
--                                   `select self_check_verdict, count(*)` is the refusal rate in
--                                   production, with no instrumentation of any kind.
--   self_check_changed  jsonb       the fields actually applied, after the allow-list and the cap.
--   self_check_after    jsonb       the FINAL spec: first draft merged with the corrections.
--   self_check_tokens   jsonb       {input, output} for the second call. The wallet captures its
--                                   cost basis from the FIRST call alone and before the second
--                                   one exists, so the basis undercounts by about 4 cents on a
--                                   checked generation. Recorded honestly here rather than
--                                   papered over; nothing is captured at all while the meter is
--                                   inactive, so today this is a forward-looking note.
--   self_check_renders  integer     how many viewpoints were actually compared. A check that ran
--                                   on one render is a different event from one that ran on four.
--   self_check_ms       integer     elapsed, to see how close the second call runs to its 45 s
--                                   ceiling on a real phone rather than on a desk.
--
-- AND THE KILL SWITCH. `client_settings.ai_style_self_check` is nullable and NULL means on, the
-- same shape as `ai_style_daily_cap` (227) and `billing_exempt` (057) — service-role only, so a
-- tenant can neither read it nor turn their own check on. It exists because one Supabase project
-- serves beta AND production and the promotion workflow is disabled: an edge deploy is live for
-- every production builder the moment it lands, and there must be a way to stop a bad check that
-- is not a rollback and does not need a deploy.
--
-- ⛔ NOT tenant-readable, and nothing here changes that. `ai_style_calls` carries no policies and
-- is service-role only, like the rest of the metering. This adds columns to it.
--
-- ⛔ NOT the renders, and NOT the raw reply from either call. The renders are throwaway JPEGs
-- that never touch storage on purpose (there is no cleanup path in the `branding` bucket and no
-- pg_cron to sweep one — migration 151 says so), and an unbounded model reply is exactly the
-- class of thing the sanitisers exist to keep out of a column. Everything stored here has been
-- through sanitizeD3Spec or is a short fixed string.
--
-- SAFE TO RE-RUN, and safe on a busy table: `add column if not exists` with no default and no
-- backfill is a catalogue-only change in Postgres 11+, so no table rewrite and no long lock.
-- Existing rows read NULL, which is the truth — nothing recorded them.

alter table public.ai_style_calls
  add column if not exists dims               jsonb,
  add column if not exists self_check_at      timestamptz,
  add column if not exists self_check_verdict text,
  add column if not exists self_check_changed jsonb,
  add column if not exists self_check_after   jsonb,
  add column if not exists self_check_tokens  jsonb,
  add column if not exists self_check_renders integer,
  add column if not exists self_check_ms      integer;

comment on column public.ai_style_calls.dims is
  'The builder''s own measurements as the server USED them: {widthFt, lengthFt, wallHeightFt, '
  'overhangIn?}. NULL means the generation had no ruler. Without this there is no way to tell a '
  'draft that was measured against a tape from one that was guessed.';
comment on column public.ai_style_calls.self_check_at is
  'When the free second pass was claimed for this row. Set by a conditional update that returns '
  'the row only while this is null, which is what makes one paid generation buy exactly one '
  'check. Also the record that a check ran.';
comment on column public.ai_style_calls.self_check_verdict is
  'matches | corrections | rejected_too_many | failed | skipped. The production refusal rate is '
  'one group-by over this column.';
comment on column public.ai_style_calls.self_check_after is
  'The FINAL spec, after the corrections were applied. `drafted` deliberately keeps the FIRST '
  'pass untouched, so "did the check help?" stays answerable by diffing the two.';
comment on column public.ai_style_calls.self_check_tokens is
  'Tokens for the second call. The wallet''s cost basis is computed from the first call alone '
  'and captured before the second exists, so it undercounts a checked generation by roughly 4 '
  'cents. Recorded here rather than corrected.';

alter table public.client_settings
  add column if not exists ai_style_self_check boolean;

comment on column public.client_settings.ai_style_self_check is
  'Whether the free self-check pass runs for this tenant. NULL = on (the default for everyone); '
  'false = skip it. Service-role only, like ai_style_daily_cap — a tenant must not be able to '
  'turn it on for themselves. It is a kill switch that needs no deploy: one project serves beta '
  'and production and the promotion workflow is disabled, so a bad check is otherwise a rollback.';

-- Refuse to report success if the columns did not land. Every write in this migration's blast
-- radius is BEST-EFFORT by design — a builder who has already been charged must never lose their
-- draft because a diagnostics write failed — so a missing column does not raise at generation
-- time. It logs a coded row and carries on, which is exactly the silent blind spot 226 was
-- written to close. The same posture, and the same guard.
do $$
declare missing text;
begin
  select string_agg(c, ', ') into missing
  from unnest(array['dims', 'self_check_at', 'self_check_verdict', 'self_check_changed',
                    'self_check_after', 'self_check_tokens', 'self_check_renders',
                    'self_check_ms']) as c
  where not exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'ai_style_calls' and column_name = c
  );
  if missing is not null then
    raise exception '247 did not add ai_style_calls columns: %', missing;
  end if;
  if not exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'client_settings' and column_name = 'ai_style_self_check'
  ) then
    raise exception '247 did not add client_settings.ai_style_self_check';
  end if;
end $$;
