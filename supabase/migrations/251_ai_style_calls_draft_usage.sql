-- 251 — What the DRAFT call used, on every generation, paid or not.
--
-- THE BUG. On 2026-09-21 15:47 a builder's 8-frame walk-around came back cut off at max_tokens
-- (ai_spec_truncated, outputTokens 8000, elapsedMs 103281) and the press failed after ~106 s. It
-- was 1 of 12 generations since the 09-17 budget fix. The next press succeeded. The obvious fixes
-- are all tuning: a larger max_tokens, a lower effort, a shorter prompt. None of them can be tuned
-- from data, because NOTHING RECORDS WHAT A SUCCESSFUL DRAFT USED.
--
--   * The self-check call has self_check_tokens / self_check_ms (247). The draft call, which is
--     the expensive one and the one that failed, has nothing equivalent.
--   * Its usage is only stored through wallet_capture, and only when a wallet hold exists.
--     usage_prices.video_3d_generation is active = false, so wallet_hold answers meter_inactive,
--     holdId is null for EVERY tenant, and wallet_transactions holds zero rows with usage. The
--     gap is platform-wide, not a demo-tenant quirk.
--   * The failure row carries outputTokens and elapsedMs, but only for the one call that failed.
--     The other eleven could have finished at 7,900 tokens and 109 s, or at 3,000 and 40 s; the
--     answer decides whether max_tokens can be raised at all, since the 110 s abort and the 150 s
--     gateway limit are coupled to it at roughly 78 tokens a second.
--
-- THE FIX. Two nullable columns beside 247's, written by portal-settings as their OWN best-effort
-- update the moment the draft reply arrives — success, refusal, truncation, unparseable, and the
-- no-reply exits (timeout, network drop, upstream error) alike.
--
--   draft_tokens  jsonb    {input, output, cache_read, cache_creation, stopReason, textChars,
--                          blockTypes}. The four counts are copied from the reply's `usage`, null
--                          where it did not say. `textChars` is the LENGTH of the text answer,
--                          which is what splits `output` into thinking versus JSON: output counts
--                          both, so a truncated reply with a short answer means thinking used the
--                          budget, and one with a long answer means the spec itself outgrew it.
--                          NULL with draft_ms set means no reply came back at all.
--   draft_ms      integer  elapsed from the request to the reply (or to the abort), to see how
--                          close real calls run to the 110 s ceiling.
--
-- ⚠️ ITS OWN UPDATE, NOT PART OF THE 226 WRITE. PostgREST refuses a whole statement when one key
-- names a column it cannot find (PGRST204). Riding these on the `recorded` update would mean that
-- between the edge deploy and this migration, every generation also lost drafted, observed and
-- frames — the blind spot 226 closed. Kept apart, a missing column costs only these two, and the
-- write logs `ai_style_draft_usage_log_failed` naming this migration. Apply this one FIRST anyway.
--
-- ⛔ NOT the reply text, and NOT anything the model said. Counts, a capped stop reason and capped
-- block type names only, the same shapes the failure rows already carry.
--
-- ⛔ NO GRANT CHANGE, and none needed. `ai_style_calls` is service-role only: RLS on, no
-- policies, table grants to postgres and service_role alone (checked live 2026-09-23). A column
-- added to an existing table inherits nothing from default privileges — that rule is about NEW
-- tables and functions — and anon/authenticated hold no column grants on it either.
--
-- SAFE TO RE-RUN, and safe on a busy table: `add column if not exists` with no default and no
-- backfill is a catalogue-only change in Postgres 11+. Existing rows read NULL, which is the
-- truth — nothing recorded them.

alter table public.ai_style_calls
  add column if not exists draft_tokens jsonb,
  add column if not exists draft_ms     integer;

comment on column public.ai_style_calls.draft_tokens is
  'The draft call''s usage: {input, output, cache_read, cache_creation, stopReason, textChars, '
  'blockTypes}. textChars is the LENGTH of the text answer, never its contents; output minus the '
  'answer is roughly the thinking. NULL with draft_ms set means the call produced no reply '
  '(timeout, network drop, upstream error).';
comment on column public.ai_style_calls.draft_ms is
  'Elapsed ms from the draft request to its reply, or to the abort. The call is cut at 110 s and '
  'the gateway at 150 s, so this is what says whether max_tokens has room to grow.';

-- Refuse to report success if the columns did not land. The write is best-effort by design, so a
-- missing column does not fail a generation — it logs a coded row and carries on, which is
-- exactly how a blind spot stays open unnoticed. Same guard as 226 and 247.
do $$
declare missing text;
begin
  select string_agg(c, ', ') into missing
  from unnest(array['draft_tokens', 'draft_ms']) as c
  where not exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'ai_style_calls' and column_name = c
  );
  if missing is not null then
    raise exception '251 did not add ai_style_calls columns: %', missing;
  end if;
end $$;
