-- 253 — A generation's ledger row carries the PRESS's key, and the frame map its answer carried.
--
-- WHY. A streamed v2 draft answers 200 at once behind a heartbeat and runs three to five minutes,
-- and a phone that backgrounds the tab drops that answer while the server works on, or after it
-- has finished and charged. calibrate_style_ai_recover picks the draft up off the ledger row
-- instead. Its first cut (2026-09-25) found that row BY TIME -- the newest row of this tenant,
-- user and style since the browser said the press began -- and guessed the money from timing too.
-- A review confirmed four ways that goes wrong:
--
--   1. A drop noticed after the press's 420 s budget (a phone resuming late) never asked at all,
--      so a drafted, paid row was lost.
--   2. Lining the browser's clock up with the server's used the poll's own round trip (auth, a
--      token refresh, a cold boot), so a slow poll's window could start AFTER the press's row
--      and answer "not charged" for a press that may have been charged.
--   3. "Failed, not charged" was decided by draft_ms + 90 s and an unchecked charged_cents write,
--      so a captured hold could be told "not charged".
--   4. Newest-first could return a LATER press's row: another tab or device, same user, same style.
--
-- All four are what matching by time costs, so the time matching is removed, not patched. The
-- browser already mints ONE idempotency key per press and sends it with the press (calIdemRef,
-- 2026-09-18); wallet_hold files the hold under it. Writing the same key onto the ledger row
-- lets the recover action find THAT press's row exactly, and read THAT press's money state from
-- wallet_transactions under the same key, instead of inferring either from a clock.
--
-- WHAT GOES IN.
--   idem_key   text   String(payload.idempotencyKey).slice(0, 120), exactly as wallet_hold's
--                     p_idem is cut, or NULL when the press sent none (production's older
--                     callers that predate the key, and the photos path). NOT unique, on
--                     purpose: one key can own several rows -- a press that failed and was
--                     released, then the builder's own retry of the same intent, or the lean
--                     retry -- and the recover action prefers the one that drafted.
--   frame_map  jsonb  The success path's frameMap (parseFrameMap: which image shows which view,
--                     at what azimuth; a handful of small integers). The free self-check cannot
--                     run without it, and until now it lived only in the answer -- so a draft
--                     picked up after a drop had to skip the check. NULL on every row written
--                     before this, on a photos draft, and where the reply carried no map.
--
-- ⚠️ BOTH WRITES ARE GUARDED, so this may land before or after the edge deploy. The insert names
-- idem_key only when there is a key, and on any failure is retried without it (one
-- `ai_style_idem_key_write_failed` info row naming this migration) -- a missing column must never
-- refuse a generation, because the insert is the spend cap and a refusal there is a 503. The
-- frame map is its OWN update after the 226 `drafted` write, so a missing column costs the map
-- and never the draft (`ai_style_frame_map_write_failed`, info). The recover action reads both
-- columns, so until this is applied it answers 503 (`ai_draft_recover_failed`) and the shell
-- keeps waiting to the press's budget, exactly as it does when the ledger cannot be read.
--
-- THE INDEX. The recover action reads `client_id = ? and idem_key = ?` on every poll (every ten
-- seconds during a pickup). Partial on `idem_key is not null`, so the rows with no key -- every
-- row before this, and every keyless caller's -- cost it nothing. Plain CREATE INDEX, not
-- CONCURRENTLY, for 155's reason: the sanctioned apply paths wrap a file in a transaction, where
-- CONCURRENTLY is illegal, and at this table's size the SHARE lock is held for milliseconds.
--
-- ⛔ NO GRANT CHANGE, and none needed. `ai_style_calls` is service-role only: RLS on, no
-- policies, and 112 revoked every privilege from anon and authenticated. A column added to an
-- existing table inherits nothing from default privileges -- that rule is about NEW tables and
-- functions -- and an index grants nothing. So a browser can neither read a key off this table
-- nor look a row up by one; only portal-settings, as the service role, filtered on the tenant
-- and user it resolved itself.
--
-- ⛔ NOT a secret. The key is a random UUID the browser minted and already holds; it proves
-- nothing on its own, and the recover action never lets it widen a read beyond the caller's own
-- tenant and user.
--
-- SAFE TO RE-RUN, and safe on a busy table: `add column if not exists` with no default and no
-- backfill is a catalogue-only change in Postgres 11+ (no table rewrite, no long lock), and
-- `create index if not exists` is a no-op the second time. Existing rows read NULL, which is the
-- truth: nothing recorded a key or a map for them.
--
-- Apply by hand (SQL editor / MCP / `supabase db query --linked -f`) and record as 253. NEVER
-- `supabase db push` -- see the migration ledger note on 126.
--
-- ROLLBACK:
--   drop index if exists public.ai_style_calls_idem_key_idx;
--   alter table public.ai_style_calls drop column if exists frame_map, drop column if exists idem_key;
-- (The edge code tolerates either column being absent; see the guarded writes above.)

alter table public.ai_style_calls
  add column if not exists idem_key  text,
  add column if not exists frame_map jsonb;

create index if not exists ai_style_calls_idem_key_idx
  on public.ai_style_calls (client_id, idem_key)
  where idem_key is not null;

comment on column public.ai_style_calls.idem_key is
  'The press''s idempotency key, cut exactly as wallet_hold''s p_idem (120 chars), or NULL when the '
  'press sent none. Not unique: a failed attempt and the retry of the same intent share one. '
  'calibrate_style_ai_recover finds a dropped streamed draft''s row by it, and reads the money '
  'state from wallet_transactions under the same key.';
comment on column public.ai_style_calls.frame_map is
  'The frameMap the success answer carried (which image shows which view, and its azimuth), '
  'written by its own best-effort update after `drafted`, so a draft picked up after its '
  'connection dropped can still run the free self-check. NULL when there was none.';

-- Refuse to report success if the columns or the index did not land. Both writes fail SOFT
-- without them (no key, no map, and every pickup a 503), which is exactly how a missing
-- migration goes unnoticed for days. Same guard as 226, 247, 251 and 252.
do $$
declare missing text;
begin
  select string_agg(c, ', ') into missing
  from unnest(array['idem_key', 'frame_map']) as c
  where not exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'ai_style_calls' and column_name = c
  );
  if missing is not null then
    raise exception '253 did not add ai_style_calls columns: %', missing;
  end if;
  if not exists (
    select 1 from pg_indexes
    where schemaname = 'public' and tablename = 'ai_style_calls' and indexname = 'ai_style_calls_idem_key_idx'
  ) then
    raise exception '253 did not create ai_style_calls_idem_key_idx';
  end if;
end $$;
