-- 252 — The free self-check runs up to three rounds per generation, and every round is on the record.
--
-- WHY. 247 made the self-check single-use: one conditional UPDATE sets `self_check_at` only while
-- it is null, so one paid generation buys exactly one check. That one check can only judge the
-- DRAFT's renders. When it corrects something — a roof read the wrong way round, a porch on the
-- wrong wall, wings it never drew — nothing ever looks at the corrected building, and a correction
-- is exactly the moment a second look is most likely to find the rest. v2 lets the browser render
-- the corrected spec and ask again, up to three rounds in all, and this is the claim and the
-- record that makes that safe.
--
-- WHAT EACH COLUMN IS FOR.
--   self_check_round   integer NOT NULL DEFAULT 0   THE CLAIM COUNTER: how many rounds have been
--                                  claimed on this row. portal-settings claims round k with one
--                                  conditional UPDATE `where self_check_round = k` that sets it to
--                                  k + 1 and returns the row (a compare-and-swap), so two requests
--                                  for one round cannot both get a row back and no round can run
--                                  twice. The server refuses k >= 3 before it gets here. Round 0
--                                  ALSO still requires `self_check_at is null`, 247's guard
--                                  verbatim, and a request with no round IS round 0 — so an older
--                                  browser keeps exactly the one check it always had, and its
--                                  second request is still a 409. Round k > 0 also requires the
--                                  row's verdict to be 'corrections' and clears it while it runs,
--                                  so a round only follows a round that finished and changed
--                                  something, and two are never in flight together.
--   self_check_rounds  jsonb           One entry per round, in order: {round, verdict, changed, ms,
--                                  tokens, renders}. Appended by its OWN best-effort update,
--                                  guarded on self_check_round, so "what did round 2 do?" survives
--                                  round 3 overwriting the scalar columns. NULL until a round runs.
--
-- WHAT THE 247 COLUMNS MEAN NOW (their comments are re-issued below to say so):
--   * `drafted` still keeps the FIRST pass, untouched by any round. Unchanged, and still the
--     load-bearing decision: "did the check help?" is a diff of `drafted` against the result.
--   * `self_check_after` is the CUMULATIVE result — the draft with every applied round — and is
--     still NULL when the check's net effect is nothing (including a later round that moved
--     everything back). A later round judges `self_check_after ?? drafted`, read off this row,
--     never anything the browser sends.
--   * `self_check_changed` is the net change against `drafted`, line by line, across all rounds.
--   * `self_check_verdict`, `_tokens`, `_renders`, `_ms` describe the LATEST round. So the
--     question 247 answered with `select self_check_verdict, count(*)` — how often does the check
--     leave a draft alone? — is now `self_check_after is null` among checked rows; a row can read
--     'matches' because its LAST round found nothing left to fix after an earlier round did.
--     Cost across rounds is the sum over `self_check_rounds[*].tokens`.
--   * `self_check_at` keeps its meaning: when the check was FIRST claimed. Only round 0 writes it.
--
-- ⚠️ APPLY THIS BEFORE THE EDGE DEPLOY. The claim names `self_check_round`, so a portal-settings
-- deployed first refuses every check at the claim — logged as `ai_selfcheck_claim_failed`, whose
-- message names this migration — and every builder simply gets no check (the safe direction: the
-- draft they paid for is untouched). One Supabase project serves beta and production.
--
-- ⚠️ ROWS CHECKED BEFORE THIS MIGRATION read round 0 with `self_check_at` set. Round 0's claim also
-- requires `self_check_at is null`, so they cannot be checked again, and round 1 requires round 1,
-- so they cannot be continued either. Nothing about an old row changes.
--
-- ⛔ NO GRANT CHANGE, and none needed. `ai_style_calls` is service-role only: RLS on, no policies,
-- table grants to postgres and service_role alone. A column added to an existing table inherits
-- nothing from default privileges — that rule is about NEW tables and functions.
--
-- ⛔ NOT the renders and NOT the raw reply of any round. Everything stored here has been through
-- sanitizeD3Spec or is a short fixed string, a count or a capped model sentence, like 247.
--
-- SAFE TO RE-RUN, and safe on a busy table: `add column if not exists`, and in Postgres 11+ a
-- NOT NULL column with a constant default is a catalogue-only change (the default is stored once,
-- not written into every row), so there is no table rewrite and no long lock. Existing rows read
-- 0 and NULL, which is the truth: no round was ever claimed through this counter.

alter table public.ai_style_calls
  add column if not exists self_check_round  integer not null default 0,
  add column if not exists self_check_rounds jsonb;

comment on column public.ai_style_calls.self_check_round is
  'How many self-check rounds have been claimed on this generation (0..3). The claim for round k '
  'is a compare-and-swap: update ... where self_check_round = k set it to k + 1, returning the row. '
  'Round 0 also requires self_check_at is null (247''s single-use guard); round k > 0 also requires '
  'self_check_verdict = ''corrections'' and clears it while it runs.';
comment on column public.ai_style_calls.self_check_rounds is
  'One entry per self-check round, in order: {round, verdict, changed, ms, tokens, renders}. '
  'Written by its own best-effort update, guarded on self_check_round. NULL until a round runs.';
comment on column public.ai_style_calls.self_check_at is
  'When the free self-check was FIRST claimed for this row (round 0). Set by a conditional update '
  'that returns the row only while this is null. Later rounds are counted in self_check_round.';
comment on column public.ai_style_calls.self_check_verdict is
  'The LATEST round''s verdict: matches | corrections | rejected_too_many | failed | skipped; NULL '
  'while a later round is in flight. Whether the check changed anything overall is '
  'self_check_after is not null; every round''s own verdict is in self_check_rounds.';
comment on column public.ai_style_calls.self_check_after is
  'The FINAL spec after every applied self-check round, or NULL when the net effect was nothing. '
  '`drafted` deliberately keeps the FIRST pass untouched, so "did the check help?" stays '
  'answerable by diffing the two. Later rounds judge this (or drafted when it is null).';
comment on column public.ai_style_calls.self_check_changed is
  'The net change against drafted, across every round: [{field, from, to, why}], from = drafted, '
  'to = self_check_after. The latest round''s own changes are in self_check_rounds.';

-- Refuse to report success if the columns did not land. The claim fails SAFE without them (no
-- check runs), which is exactly how a missing migration goes unnoticed for days. Same guard as
-- 226, 247 and 251.
do $$
declare missing text;
begin
  select string_agg(c, ', ') into missing
  from unnest(array['self_check_round', 'self_check_rounds']) as c
  where not exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'ai_style_calls' and column_name = c
  );
  if missing is not null then
    raise exception '252 did not add ai_style_calls columns: %', missing;
  end if;
  if exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'ai_style_calls'
      and column_name = 'self_check_round' and (is_nullable <> 'NO' or column_default is null)
  ) then
    raise exception '252: ai_style_calls.self_check_round must be NOT NULL DEFAULT 0 — a NULL round matches no claim, so every check would 409';
  end if;
end $$;
