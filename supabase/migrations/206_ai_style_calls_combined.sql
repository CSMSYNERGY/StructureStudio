-- 206_ai_style_calls_combined.sql — one generation may read a video AND photos, and it is
--                                   charged like any other generation.
--
-- ── WHY ───────────────────────────────────────────────────────────────────────────────────
-- Ahsan, 2026-09-07: "I want the users to upload the video and images both after that we
-- generate the 3D model."
--
-- Carolyn had already settled the cost question that makes this affordable, on 09-04 @19:34.
-- Ahsan warned combining two sources would cost double; her answer:
--
--   "Well, and I'm not so concerned about that. What I am most concerned about is to give
--    them as accurate of a building as possible, even if it's, then yes, then combine all of
--    the sources. That is my main thing."
--
-- And on the charge itself, @20:47: "I don't have to make any money. I just want the cost to
-- be covered because I don't want them coming in here and saying, oh, this is fun. Click."
-- The $20 is a rate limiter, not a margin. That is the whole reason ONE price survives here.
--
-- ── WHAT CHANGES ─────────────────────────────────────────────────────────────────────────
-- 1. `ai_style_calls.source` accepts 'combined'. The column exists to answer "how many PAID
--    generations happened", so a third input shape needs a third value rather than being
--    filed under one of the two it is not.
-- 2. `usage_prices.video_3d_generation` loses its video-only LABEL. The `kind` is a key and
--    does NOT change — renaming it would orphan every historical wallet_transactions row
--    that references it, and there is no gain: the string is never shown to anyone.
--
-- ⚠️ ONE PRICE, NOT THREE, AND THIS REVERSES 129's REASONING — recorded rather than deleted.
-- 129's header argued the charge should ride video only, on two grounds: "the $20 is priced
-- off the video's Anthropic cost", and "the four-slot photo path is slated for removal —
-- charging $20 for a flow we are about to delete is a support liability with no upside."
--
-- The second ground is simply gone: the photo slots came back on 2026-09-04 at Carolyn's
-- request, labelled and expanded, because one-way-in cost accuracy she was not willing to
-- trade. The first ground is now the argument FOR a flat price rather than against it — a
-- combined run costs us more than a photo-only run, and pricing each shape separately would
-- mean a builder paying more for the accurate answer, which is exactly backwards from
-- "I want to give them as accurate of a building as possible."
--
-- So: one press is one hold is one charge, whichever inputs it used. A builder can always
-- predict what pressing the button costs, which is the only property a rate limiter needs.
--
-- ⚠️ THE METER'S ARMING STATE IS NOT TOUCHED HERE. `active` stays exactly as it is. Whether
-- the charge is live is a separate, deliberate decision (128's arming rail) and it must not
-- ride along with a schema change — read the row before assuming either way.
--
-- HAND-APPLY: pipe this file to `supabase db query --linked`. NOT `--file` (auth-fails,
-- retries, still exits 0) and NOT with a `--` separator (that makes the CLI read stdin and
-- ignore the argument). Then record in supabase_migrations.schema_migrations. BOM-free.

do $$
begin
  if exists (
    select 1 from pg_constraint
    where conrelid = 'public.ai_style_calls'::regclass and contype = 'c'
      and pg_get_constraintdef(oid) like '%source%'
  ) then
    alter table public.ai_style_calls drop constraint if exists ai_style_calls_source_check;
  end if;
  alter table public.ai_style_calls
    add constraint ai_style_calls_source_check
    check (source in ('photos', 'video', 'combined'));
end $$;

comment on column public.ai_style_calls.source is
  'Which inputs the generation read: photos (staged stills), video (frames the browser cut '
  'from a walk-around), or combined (both, 2026-09-07). All three are charged identically — '
  'the price is a rate limiter, not a cost recovery, so the accurate option is never the '
  'expensive one.';

update public.usage_prices
   set label = '3D model from photos and video',
       note = 'One press is one charge, whichever inputs it read. The kind string stays '
              'video_3d_generation because it is a key referenced by wallet_transactions; '
              'only the wording changed (2026-09-07).',
       updated_at = now()
 where kind = 'video_3d_generation';

do $$
declare v_ok boolean;
begin
  select count(*) = 1 into v_ok from pg_constraint
   where conrelid = 'public.ai_style_calls'::regclass
     and conname = 'ai_style_calls_source_check'
     and pg_get_constraintdef(oid) like '%combined%';
  if not v_ok then
    raise exception '206: the source constraint did not land with combined — refusing to report success';
  end if;
  raise notice '206: ai_style_calls.source accepts combined; usage_prices label updated';
end $$;
