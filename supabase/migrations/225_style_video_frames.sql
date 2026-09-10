-- 225 — The walk-around's frames get their own column.
--
-- WHY A SECOND COLUMN AND NOT MORE ROOM IN d3_photos.
-- Until 2026-09-10 a walk-around import wrote four of its eight frames into d3_photos, spread
-- across the same four slots the builder's own Front / Left side / Right side / Back photos use.
-- Three things followed from that, and only the third needed a migration:
--
--   1. Filling the four named slots and THEN filming a lap silently destroyed all four photos.
--   2. Only four of the eight frames ever reached a generation, because the combined call sent
--      d3_photos and the other four frames lived in browser state nothing read.
--   3. "Has this style got a walk-around video?" had no answer after a reload. Every URL in
--      d3_photos looks the same; nothing distinguishes a frame from a photograph. That question
--      is now a GATE — Ahsan, 2026-09-10: "once they have uploaded both a video and four images,
--      then they can generate the 3D model" — so a builder who filmed a lap, saved, and came
--      back the next morning would have been told to go and film it again.
--
-- Separate columns are the honest model: they answer different questions and they are written by
-- different acts. A discriminator inside one array (a prefix, a filename convention) would have
-- put the same information somewhere no constraint can defend it.
--
-- NOT ADDED TO get_config. 093 took d3_photos out of the anonymous customer payload precisely
-- because these are photographs of a builder's real buildings; frames cut out of their video are
-- the same class of thing, so this column is read only over an authenticated session (the
-- portal-settings `catalog` action). There is deliberately nothing to change in get_config —
-- 086's builder emits named keys, so a new column is invisible to it unless someone adds it.
--
-- SAFE TO RE-RUN. `add column if not exists`, no backfill, no default: existing styles read as
-- NULL, which the editor and both save paths already treat as "no video yet".

alter table public.building_styles
  add column if not exists d3_video_frames jsonb;   -- up to 8 walk-around frame URLs (SS_VID_FRAMES)

comment on column public.building_styles.d3_video_frames is
  'Walk-around video frames the 3D spec was calibrated against, in walk order. Separate from '
  'd3_photos (the builder''s own staged photographs) because the two answer different questions '
  'and the Generate gate needs to tell them apart. Capped at 8 by sanitizePhotoUrls; never '
  'emitted by get_config — see migration 093.';

-- Refuse to report success if the column did not land. A missing column here does not error at
-- save time: `.update({ d3_video_frames: ... })` against PostgREST would 400, but the failure a
-- builder actually sees is "Save failed" with no clue why, so it is worth catching here.
do $$
begin
  if not exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'building_styles' and column_name = 'd3_video_frames'
  ) then
    raise exception '225 did not add building_styles.d3_video_frames';
  end if;
end $$;
