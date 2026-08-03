-- 071_floor_plans_bucket_hardening.sql
--
-- Two independent holes in the PUBLIC floor-plans bucket, both reachable with nothing but the
-- anon key that is baked into the public designer page.
--
-- 1. DROP floor_plans_code_update.
--    Migration 031 created it as `FOR UPDATE TO public` with the object-NAME regex as both its
--    USING and WITH CHECK clause and no ownership predicate at all. The name shape is not an
--    authorization check: any caller who knows (or guesses) an existing key can satisfy it, so
--    anon could OVERWRITE any tenant's floor-plan PDF — the document their customer is quoting
--    from and the file linked out of a sent GHL estimate. Nothing legitimate needs UPDATE: the
--    one and only browser upload is
--        supabase.storage.from("floor-plans").upload(path, blob, { upsert: false, ... })
--    which is a pure INSERT and is served by floor_plans_code_insert. Every other write to
--    storage in this repo goes to `branding` or `fixtures` through a SERVICE-ROLE client inside
--    an edge function, which bypasses RLS entirely (those two buckets have no policies at all).
--    Verified before dropping: exactly four policies exist on storage.objects, and no code path
--    passes upsert:true for this bucket.
--
--    Consequence worth knowing: with UPDATE gone, an upload to an existing key now fails rather
--    than silently replacing the object. That is the intended behaviour — short codes carry a
--    Date.now() suffix, so a legitimate re-submit always writes a NEW key.
--
-- 2. Cap size and pin the content type (audit #23).
--    The bucket had file_size_limit NULL and allowed_mime_types NULL, so a caller holding the
--    anon key could POST unbounded bodies with any Content-Type into a publicly-served bucket:
--    an unbounded storage bill, and attacker-chosen content served from the project's own domain
--    (i.e. phishing or malware hosted under our name). Compare feedback-attachments, which has
--    had a 25 MB cap and a 7-entry allow-list since it shipped — the tightening was simply never
--    applied to this bucket.
--
--    Numbers are from the live bucket, not guessed: 207 objects, largest 245 kB, p99 241 kB.
--    5 MB is ~20x the observed maximum, so it cannot reject a real floor plan while still
--    bounding the damage. Pinning application/pdf is the load-bearing half — it means a planted
--    file is served as a PDF rather than as a page, so it cannot execute as HTML in a browser.
--    (The 16 legacy image/png objects are unaffected: allowed_mime_types constrains uploads, not
--    reads, so they keep serving. The sole uploader has always sent application/pdf.)
--
--    This does NOT make the bucket safe on its own — it is defence in depth behind the name
--    regex and behind 068's save_design sanitiser. A caller can still declare application/pdf
--    and send other bytes; what it can no longer do is choose how those bytes are served.

drop policy if exists floor_plans_code_update on storage.objects;

update storage.buckets
   set file_size_limit   = 5242880,               -- 5 MB; live max is 245 kB
       allowed_mime_types = array['application/pdf']
 where id = 'floor-plans';
