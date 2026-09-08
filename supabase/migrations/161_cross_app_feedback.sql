-- 161_cross_app_feedback: bug/feature intake from FramedUp, BuildBridge and CSM Studio.
--
-- Carolyn 2026-09-07: those apps collected feedback by embedding a Monday.com WorkForm in
-- an iframe (CSM Studio had nothing at all). Retiring the Monday subscription would have
-- killed the button in two live apps, and an iframe leaves no record on our side and
-- cannot attribute a submission to a person — the same two reasons Structure Studio's own
-- widget was rebuilt off Monday. All three now file onto these boards instead.
--
-- ⚠️ APPLY BY HAND (SQL editor / MCP) and record in supabase_migrations.schema_migrations.
-- NEVER `supabase db push`. Numbered 161: the LEDGER's 3-digit max was 160 (the folder also
-- holds a 204_rate_buckets from a parallel working line, ledgered under a timestamp version
-- — the ledger is the source of truth for the next number, not this directory).

-- ── Where a submission came from ────────────────────────────────────────────
-- source_app: which PRODUCT filed it. Never read from a request body — app-feedback
--   derives it from which shared secret the caller presented, so an app cannot file as
--   another app. Defaulted for every existing row, all of which are builder submissions.
-- source_ref: which customer OF THAT APP (BuildBridge's GHL locationId, CSM Studio's
--   user_id). Informational, for triage only.
alter table public.feedback_submissions
  add column if not exists source_app text not null default 'structure-studio';
alter table public.feedback_submissions
  add column if not exists source_ref text;

-- client_id MEANS TENANT, and a FramedUp user is not a tenant of anything here. Rather
-- than overload it with an app slug — which would make the Projects "Client" cell and the
-- Monday detail block read like a builder name — cross-app rows carry NULL and say what
-- they are in source_app. RLS is `client_id = current_client_id()` (054), and NULL never
-- satisfies it, so these rows stay invisible to every builder. That is the intent, not a
-- side effect: nobody outside the team should see another product's bug list.
alter table public.feedback_submissions alter column client_id drop not null;

create index if not exists feedback_submissions_source_app_idx
  on public.feedback_submissions (source_app, created_at desc);

-- ── The boards learn about the other apps ───────────────────────────────────
-- DATA, not schema: pm_columns rows are edited through the Projects UI, so this block is
-- the repo's record of a change made to live data, and is written to be re-runnable.
--
-- The bugs board already had an App dropdown (built by hand in the UI, in no migration)
-- carrying Structure Studio / Framed UP / CSM Studio. It was missing BuildBridge, the
-- features board had no App column at all, and mirrorToProjects never wrote either one —
-- so the single populated value on the whole board had been set by hand.
update public.pm_columns c
set settings = jsonb_set(
      c.settings, '{options}',
      (c.settings->'options') || jsonb_build_array(
        jsonb_build_object('id','o_buildbridge','color','#0F766E','label','BuildBridge'))
    )
from public.pm_boards b
where b.id = c.board_id and b.slug = 'bugs' and c.name = 'App' and c.type = 'dropdown'
  and not (c.settings->'options' @> '[{"label":"BuildBridge"}]'::jsonb);

insert into public.pm_columns (board_id, name, type, position, settings)
select b.id, 'App', 'dropdown', 7168,
       jsonb_build_object('options', jsonb_build_array(
         jsonb_build_object('id','o_ss',          'color','#3D3672','label','Structure Studio'),
         jsonb_build_object('id','o_framedup',    'color','#1B7895','label','Framed UP'),
         jsonb_build_object('id','o_csmstudio',   'color','#0891B2','label','CSM Studio'),
         jsonb_build_object('id','o_buildbridge', 'color','#0F766E','label','BuildBridge')))
from public.pm_boards b
where b.slug = 'features'
  and not exists (select 1 from public.pm_columns x
                  where x.board_id = b.id and x.name = 'App' and x.type = 'dropdown');
