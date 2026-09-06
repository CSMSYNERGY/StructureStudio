-- 205_save_design_follow_splice.sql — the manual step 189 asks for, done safely.
--
-- 189 PART 3 created `crm_quote_assign` and then said, correctly, that save_design has to be
-- edited by hand:
--
--   "save_design has been replaced wholesale several times (031's version snapshot, 104's
--    inventory-master protection, 111's invoiced protection, 133's CRM link) and the repo's
--    newest copy of it is EVIDENCE, not the source of truth. Rebuilding it from any file —
--    including 133 — can silently un-ship whatever landed after that file was written."
--
-- That warning is about rebuilding from a FILE, and it stands. This migration does not do
-- that. It reads the LIVE body with pg_get_functiondef, inserts one block, and re-executes
-- the result — so whatever landed after 133 is carried through untouched by construction,
-- because it is never re-typed.
--
-- ⚠️ NUMBERED 205, NOT 194. A concurrent session applied 188, 193, 194, 197, 199 and 204 to
-- this database on 2026-09-06 while this work was in flight; 205 is the first free number
-- above their highest. Our own 187–193 files already collide with theirs by prefix and want
-- renumbering — the ledger keys on the timestamp `version` so nothing is broken, but "what is
-- the latest migration" can no longer be answered by reading the highest prefix. Same
-- situation 183 is already in.
--
-- ── WHAT IS INSERTED, AND WHY IT IS NOT FOLDED INTO 133's BLOCK ───────────────────────────
-- 133's CRM-link block ends `exception when others then null;` and its header explains why:
-- CRM bookkeeping must never fail a customer's design save. Nothing here weakens that.
--
-- But the consequence is that any NEW failure added inside that block is invisible by
-- construction — no exception, no log, no row, and the only symptom is an absence somebody
-- would have to already suspect. 133 could live with that because its failure mode is
-- self-healing: 130's backfill is re-runnable and picks up an unstamped design later.
--
-- THIS ONE IS NOT SELF-HEALING. Nothing can reconstruct who was signed in when a quote was
-- sent, because auth.uid() exists only during the request. A follow that silently fails is
-- gone for good. So the block is SEPARATE and it RECORDS: the design still saves either way,
-- and app_errors gets a row saying the follow did not happen — the difference between a bug
-- that is found and one that is not. Severity 'error' per 141: this is a fault, not the
-- server refusing something.
--
-- The log call is itself wrapped, because a logger that can throw would defeat the guard it
-- sits inside and hand the customer the failed save all of this exists to prevent.
--
-- ── SAFETY ───────────────────────────────────────────────────────────────────────────────
-- Three guards, and the migration does nothing at all rather than half a thing:
--   1. Already-spliced is a no-op, not an error — so a re-run is safe.
--   2. The anchor must appear EXACTLY ONCE. If save_design changes shape under us, this
--      aborts rather than splicing into the wrong place or silently matching nothing.
--   3. The result must be longer than the original by exactly the inserted length, which is
--      what proves the replace did one insertion and no deletion.
--
-- AFTER APPLYING, PROVE IT: submit one real design FROM THE PORTAL (signed in — the anon
-- designer has no auth.uid() and will correctly record nothing) on an internal tenant with
-- beta mode and a test inbox, then confirm a crm_contact_followers row appeared.
--
-- ROLLBACK: re-run this file's anchor replacement in reverse, or restore save_design from
-- pg_get_functiondef captured before applying. Capture it first if you want that option.
--
-- HAND-APPLY (pipe the file to `supabase db query --linked` — NOT `--file`, which auth-fails,
-- retries and still exits 0; and NOT with a `--` separator, which makes the CLI read stdin
-- and ignore the argument). Then record in supabase_migrations.schema_migrations. BOM-free.

do $splice$
declare
  v_src    text := pg_get_functiondef('public.save_design'::regproc);
  v_anchor text := E'  exception when others then\n    null;\n  end;\n\n  return v_row;';
  v_add    text := E'\n  -- CONTACT ASSIGNMENT + AUTO-FOLLOW (migration 189). Carolyn 2026-09-04 @1:09:30: "we do\n  -- not ever assign deals. We only assign contacts and followers." The rep who sends the\n  -- quote follows the customer, and becomes the assignee under the tenant''s\n  -- crm_assign_latest_quote rule.\n  --\n  -- SEPARATE FROM THE BLOCK ABOVE ON PURPOSE. That one swallows, which is right for\n  -- something a re-runnable backfill repairs. Nothing can reconstruct who was signed in, so\n  -- this one records the failure instead of hiding it.\n  begin\n    perform public.crm_quote_assign(p_client_id, v_row.contact_id, auth.uid());\n  exception when others then\n    begin\n      perform public.log_error(\n        ''save_design'',\n        ''crm_quote_assign failed: '' || coalesce(sqlerrm, ''(no message)''),\n        ''crm_quote_assign'',\n        p_client_id,\n        null,\n        jsonb_build_object(''code'', p_code, ''sqlstate'', sqlstate),\n        ''error'');\n    exception when others then\n      null;                      -- a logger that throws must never fail the design save\n    end;\n  end;\n';
  v_hits   int;
  v_new    text;
begin
  -- GUARD 1 — idempotent. A second run is a no-op, never a second copy of the block.
  if v_src like '%crm_quote_assign%' then
    raise notice '205: save_design already carries the crm_quote_assign block — nothing to do';
    return;
  end if;

  -- GUARD 2 — the anchor must be unique. `return v_row;` is included precisely to make it so:
  -- `exception when others then null; end;` on its own appears more than once in this body.
  v_hits := (length(v_src) - length(replace(v_src, v_anchor, ''))) / length(v_anchor);
  if v_hits <> 1 then
    raise exception '205: anchor found % time(s), expected exactly 1 — save_design has changed shape; re-derive the anchor from pg_get_functiondef before retrying', v_hits;
  end if;

  v_new := replace(v_src, v_anchor,
    E'  exception when others then\n    null;\n  end;\n' || v_add || E'\n  return v_row;');

  -- GUARD 3 — one insertion, no deletion. If the lengths do not line up the replace did
  -- something other than what this file describes, and executing it would be a guess.
  if length(v_new) <> length(v_src) + length(v_add) then
    raise exception '205: spliced body is % chars, expected % — refusing to execute', length(v_new), length(v_src) + length(v_add);
  end if;

  execute v_new;
  raise notice '205: spliced crm_quote_assign into save_design (% -> % chars)', length(v_src), length(v_new);
end
$splice$;
