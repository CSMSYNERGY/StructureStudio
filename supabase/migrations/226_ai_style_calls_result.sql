-- 226 — Record what a generation actually RETURNED, not just that it happened.
--
-- WHY. `ai_style_calls` has metered generations since 129 and answers "did it run, who ran it,
-- what did it cost". It has never answered the only question that matters when a builder says
-- the model is wrong: WHAT DID IT SAY? The drafted spec is returned to the browser and applied
-- to an in-memory draft; unless the builder then presses Save, it exists nowhere else. On
-- 2026-09-10/11 three generations ran and not one was saved, so every accuracy report had to be
-- diagnosed from a screenshot and a description.
--
-- That is the whole reason for this migration: three rounds of "it is not accurate" with no way
-- to see the output. Now every generation is inspectable after the fact, whether or not anyone
-- saves it.
--
-- WHAT GOES IN, AND WHAT DELIBERATELY DOES NOT.
--   drafted     the sanitised d3 spec that was returned. Small (sanitizeD3Spec caps it at 4KB)
--               and already safe — it is a whitelist rebuild, not raw model output.
--   observed    the model's prose notes about roof/eave/doors/windows/vents/confidence. Also
--               already sanitised (parseObservedNotes, known keys, 240 chars each).
--   frames      how many images it actually read, after the cap.
--   video_count how many of those were walk-around frames rather than staged photos.
--
-- ⛔ NOT the photo URLs, and NOT the raw model reply. The URLs are already on the style row when
-- a save happens, and duplicating an unguessable capability into a second table widens the
-- surface for nothing. The raw reply is unbounded model output, which is exactly the class of
-- thing sanitizeD3Spec exists to keep out of storage.
--
-- ⛔ NOT tenant-readable. `ai_style_calls` carries no policies and is service-role only, like
-- the rest of the metering; this adds columns to it and changes none of that. A builder sees
-- the drafted spec in their own editor, which is where it belongs.
--
-- SAFE TO RE-RUN, and safe on a busy table: `add column if not exists` with no default and no
-- backfill is a catalogue-only change in Postgres 11+, so it takes no table rewrite and no long
-- lock. Existing rows read NULL, which is the truth — nothing recorded them.

alter table public.ai_style_calls
  add column if not exists drafted     jsonb,
  add column if not exists observed    jsonb,
  add column if not exists frames      integer,
  add column if not exists video_count integer;

comment on column public.ai_style_calls.drafted is
  'The sanitised d3 spec this generation returned. Recorded because a draft the builder never '
  'saves exists nowhere else, which made every accuracy report undiagnosable.';
comment on column public.ai_style_calls.observed is
  'The model''s prose notes (roof, eave, doors, windows, vents, confidence) for this generation.';
comment on column public.ai_style_calls.video_count is
  'How many of `frames` were walk-around frames rather than staged photographs.';

-- Refuse to report success if the columns did not land. A missing column here does not error at
-- generation time — the ledger update is deliberately best-effort, so it would fail silently and
-- leave exactly the blind spot this migration exists to close.
do $$
declare missing text;
begin
  select string_agg(c, ', ') into missing
  from unnest(array['drafted', 'observed', 'frames', 'video_count']) as c
  where not exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'ai_style_calls' and column_name = c
  );
  if missing is not null then
    raise exception '226 did not add ai_style_calls columns: %', missing;
  end if;
end $$;
