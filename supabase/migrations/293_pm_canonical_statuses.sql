-- 293_pm_canonical_statuses.sql — ONE status list on Bugs, Feature Requests and Ongoing Projects.
--
-- ⛔ APPLY BY HAND, AFTER A HUMAN HAS READ IT (`supabase db query --linked --file <this file>`),
--    then read R1/R2/R3 back (bottom of this file) and record the ledger row with `returning`.
--    NEVER `supabase db push`. The file carries its own begin;/commit;, so every assertion below
--    takes the whole migration with it if it fails. THE NUMBER IS TENTATIVE: take the next free
--    version from the LIVE ledger at apply time (288 is missing from the ledger; do not reuse it).
--
-- ── WHY ──────────────────────────────────────────────────────────────────────────────────
-- Each board grew its own status vocabulary: Bugs had Awaiting Review / Ready for Dev / Known Bug /
-- Fixing / Pending Deploy / Fixed / Missing Info, Feature Requests had New / Under Review / Planned /
-- Completed / Declined, and Ongoing Projects (slug `working`, an overlay of the other two) had its
-- own To Do / Doing / Blocked plus a copy of all twelve. A label id only means something on the
-- board that owns it, so from Ongoing Projects a Feature label on a Bug row (or To Do on any
-- pulled-in row) was refused with a 400. One list, identical on all three boards, makes every
-- label valid on every row, and gives release-ci two ids it can rely on: l_onbeta and l_done.
--
-- ── THE LIST (identical on bugs, features and working, in this order) ───────────────────
--   l_new        New           submitted     intake
--   l_review     Under Review  in_review
--   l_missinfo   Missing Info  needs_info    kind stuck
--   l_planned    Planned       planned
--   l_inprogress In Progress   in_progress   kind working
--   l_onbeta     On Beta       in_progress   kind working   <- release-ci moves items here
--   l_done       Done          shipped       kind done      <- and here at promotion
--   l_declined   Declined      declined      kind done
--   l_dup        Duplicate     duplicate     kind done
-- Builders never see these words: feedback_submissions keeps its own 8-state ladder (054), and a
-- label only reaches a builder through its client_status (On Beta reads "In progress", Done reads
-- "Completed" in the portal's FB_STATUS).
--
-- ── THE MAP (old ids are unique across the three boards, so one global map) ─────────────
--   l_awaiting, l_todo      -> l_new
--   l_readydev, l_sprints   -> l_planned
--   l_knownbug              -> l_review
--   l_fixing, l_doing       -> l_inprogress
--   l_pendeploy             -> l_onbeta
--   l_fixed                 -> l_done
--   l_blocked               -> l_missinfo
--   every canonical id      -> itself (so a re-apply is a no-op)
-- Every done label maps to a done label and every other label to a not-done one, so no item can
-- appear on or drop off Ongoing Projects because of this file. PART 4 asserts exactly that.
--
-- ── WHAT IT READS (pre-read R1/R2/R3, read-only, 2026-10-09) ─────────────────────────────
--   R1 labels: bugs 7 (l_awaiting intake, l_readydev, l_knownbug, l_fixing, l_pendeploy, l_fixed,
--      l_missinfo), features 5 (l_new intake, l_review, l_planned, l_done, l_declined), working 15
--      (l_todo intake, l_doing, l_blocked + the twelve). All are keys of the map.
--   R2 item values: bugs l_awaiting/l_fixed/l_fixing/l_knownbug/l_missinfo/l_readydev and one
--      archived NULL; features l_declined/l_done/l_new/l_planned/l_review; working l_todo. All keys.
--   R3 saved-view facets on a status column: two, both on bugs, both plain strings (l_readydev,
--      l_awaiting). Arrays are handled too, and "__none" (the no-value bucket) is left alone.
-- PART 1 refuses the whole file if live has drifted from that: any label id, item value or facet
-- value that is not a key of the map aborts with nothing written.
--
-- ── WHAT IT TOUCHES / WHAT IT DOES NOT ───────────────────────────────────────────────────
--   * pm_columns.settings.labels of the FIRST status column (by position) of each of the three
--     boards, found by board SLUG, exactly as statusColumnOf (_shared/pmOverlay.ts) finds it. No
--     uuid appears in this file. Other keys of settings are kept.
--   * pm_items.values[that column] — ARCHIVED ITEMS INCLUDED, so un-archiving one never brings a
--     dead id back. A NULL (or JSON null, or absent) value stays exactly as it is. updated_at is
--     NOT bumped: nobody edited the item, and a bump would claim activity that did not happen.
--   * pm_views.snap.facets[that column] on those boards (string or array; "__none" untouched).
--   * NOT the roadmap board (its own Idea/Planned/Building/Shipped list), NOT feedback_submissions
--     (no builder-visible status changes at apply time), NOT pm_activity history, NOT any second
--     status column a board may have.
--
-- ── BACKUP ───────────────────────────────────────────────────────────────────────────────
-- Every row this file changes is copied first into public.pm_status_backup_293 (the column's whole
-- settings, the item's old status value, the view's old facet). RLS is switched on HERE, explicitly
-- (the project's auto-enable trigger is not in the repo and cannot be relied on), and the table is
-- revoked from public, anon and authenticated: only the service role reads it. A re-apply inserts
-- nothing (on conflict do nothing keeps the first, real "before").
--
-- ── AFTER APPLY: what changes for people ─────────────────────────────────────────────────
--   * Operators see the new words on all three boards. Saved views are rewritten with the items,
--     so "Ready" now filters on Planned and "AWAITING" on New.
--   * Linked items whose label's client_status changes: only l_awaiting (in_review -> submitted).
--     A NOTICE counts them. Their builder-visible status is NOT rewritten here; it changes only if
--     someone sets a status on the item afterwards (propagateStatus), which is the normal path.
--   * New states become possible: "Needs your info" and "Already tracked" on Features, "Not
--     planned" on Bugs, and On Beta everywhere.
--   * scripts/import-monday.mjs and the admin-import-monday function match Monday's label TEXT
--     onto these boards; after this file a re-run would blank statuses, so both now refuse to run.
--
-- ── ROLLBACK (from the backup; run in one transaction, only before anyone has used a new id) ──
--   begin;
--   update public.pm_columns c set settings = b.before
--     from public.pm_status_backup_293 b where b.kind = 'column' and b.row_id = c.id;
--   update public.pm_items i set values = jsonb_set(i.values, array[b.col_id::text], b.before)
--     from public.pm_status_backup_293 b where b.kind = 'item' and b.row_id = i.id;
--   update public.pm_views v set snap = jsonb_set(v.snap, array['facets', b.col_id::text], b.before)
--     from public.pm_status_backup_293 b where b.kind = 'view' and b.row_id = v.id;
--   commit;
--   -- then: drop table public.pm_status_backup_293;
-- ⚠️ An item set to an id the OLD lists lack (l_inprogress on Features, l_onbeta, l_dup on Features,
-- anything on Working's own items) AFTER the apply is not in the backup. Find those first with
--   select i.id, i.values->>(c.id::text) from public.pm_items i join public.pm_columns c on c.board_id = i.board_id
--   where c.id in (select row_id from public.pm_status_backup_293 where kind = 'column')
--     and i.id not in (select row_id from public.pm_status_backup_293 where kind = 'item')
--     and i.values->>(c.id::text) is not null;
-- and decide each by hand. The rollback also restores an item's OLD status over any change made
-- since; that is what "rollback" means here.

begin;

-- ── PART 0: the map and the list ─────────────────────────────────────────────────────────
create temp table m293_map (old_id text primary key, new_id text not null) on commit drop;
insert into m293_map (old_id, new_id) values
  ('l_awaiting',   'l_new'),
  ('l_todo',       'l_new'),
  ('l_readydev',   'l_planned'),
  ('l_sprints',    'l_planned'),
  ('l_knownbug',   'l_review'),
  ('l_fixing',     'l_inprogress'),
  ('l_doing',      'l_inprogress'),
  ('l_pendeploy',  'l_onbeta'),
  ('l_fixed',      'l_done'),
  ('l_blocked',    'l_missinfo'),
  ('l_new',        'l_new'),
  ('l_review',     'l_review'),
  ('l_missinfo',   'l_missinfo'),
  ('l_planned',    'l_planned'),
  ('l_inprogress', 'l_inprogress'),
  ('l_onbeta',     'l_onbeta'),
  ('l_done',       'l_done'),
  ('l_declined',   'l_declined'),
  ('l_dup',        'l_dup');

-- Every label in the shape portal-projects' sanitizeSettings writes (id, label, color, and the
-- optional kind / client_status / intake), so the first save from Board settings round-trips it.
create temp table m293_canon on commit drop as
select '[
  {"id":"l_new","label":"New","color":"#F59E0B","client_status":"submitted","intake":true},
  {"id":"l_review","label":"Under Review","color":"#8B5CF6","client_status":"in_review"},
  {"id":"l_missinfo","label":"Missing Info","color":"#F97316","kind":"stuck","client_status":"needs_info"},
  {"id":"l_planned","label":"Planned","color":"#6366F1","client_status":"planned"},
  {"id":"l_inprogress","label":"In Progress","color":"#2563EB","kind":"working","client_status":"in_progress"},
  {"id":"l_onbeta","label":"On Beta","color":"#0891B2","kind":"working","client_status":"in_progress"},
  {"id":"l_done","label":"Done","color":"#0E9F6E","kind":"done","client_status":"shipped"},
  {"id":"l_declined","label":"Declined","color":"#94A3B8","kind":"done","client_status":"declined"},
  {"id":"l_dup","label":"Duplicate","color":"#64748B","kind":"done","client_status":"duplicate"}
]'::jsonb as labels;

-- ── PART 1: find the three status columns, and refuse anything the map does not know ────
-- The first status column by position on each board — statusColumnOf's rule, and the one the
-- pre-read used. By slug, never by uuid.
create temp table m293_cols on commit drop as
select distinct on (c.board_id) b.slug, c.board_id, c.id as col_id, c.position, c.settings as settings_before
  from public.pm_columns c
  join public.pm_boards b on b.id = c.board_id
 where c.type = 'status' and b.slug in ('bugs', 'features', 'working')
 order by c.board_id, c.position;

do $$
declare
  n int;
  bad text;
begin
  select count(*) into n from m293_cols;
  if n <> 3 or (select count(distinct slug) from m293_cols) <> 3 then
    raise exception '293: expected one status column on each of bugs, features and working, found % — nothing was written', n;
  end if;

  -- Two status columns at the same first position would make "the first" depend on row order.
  select string_agg(m.slug, ', ' order by m.slug) into bad
    from m293_cols m
   where (select count(*) from public.pm_columns c
           where c.board_id = m.board_id and c.type = 'status' and c.position = m.position) > 1;
  if bad is not null then
    raise exception '293: two status columns share the first position on % — the board''s status column is ambiguous; nothing was written', bad;
  end if;

  select string_agg(m.slug, ', ' order by m.slug) into bad
    from m293_cols m where jsonb_typeof(m.settings_before -> 'labels') is distinct from 'array';
  if bad is not null then
    raise exception '293: the status column on % has no labels array — nothing was written', bad;
  end if;

  -- (a) every live label id is a key of the map
  select string_agg(distinct m.slug || ':' || coalesce(left(l ->> 'id', 40), '<no id>'), ', ') into bad
    from m293_cols m
   cross join lateral jsonb_array_elements(m.settings_before -> 'labels') l
   where not exists (select 1 from m293_map x where x.old_id = l ->> 'id');
  if bad is not null then
    raise exception '293: unknown status label id(s) % — map them or fix the board first; nothing was written', bad;
  end if;

  -- (b) every non-null item value (archived included) is a string and a key of the map
  select string_agg(distinct m.slug || ':' || case when jsonb_typeof(i.values -> m.col_id::text) = 'string'
                                                   then left(i.values ->> m.col_id::text, 40)
                                                   else '<' || jsonb_typeof(i.values -> m.col_id::text) || '>' end, ', ') into bad
    from public.pm_items i
    join m293_cols m on m.board_id = i.board_id
   where i.values ? m.col_id::text
     and jsonb_typeof(i.values -> m.col_id::text) <> 'null'
     and (jsonb_typeof(i.values -> m.col_id::text) <> 'string'
          or not exists (select 1 from m293_map x where x.old_id = i.values ->> m.col_id::text));
  if bad is not null then
    raise exception '293: unknown item status value(s) % — nothing was written', bad;
  end if;

  -- (c) every saved-view facet on the status column: a string or an array of strings, each a key
  --     of the map or the "__none" bucket. A null facet is no filter and is left alone.
  select string_agg(distinct m.slug || ':' || left(e.val, 40), ', ') into bad
    from public.pm_views v
    join m293_cols m on m.board_id = v.board_id
   cross join lateral (
     select f, jsonb_typeof(f) t from (select v.snap -> 'facets' -> m.col_id::text as f) s
   ) ff
   cross join lateral (
     select case when jsonb_typeof(el) = 'string' then el #>> '{}' else '<' || jsonb_typeof(el) || '>' end as val
       from jsonb_array_elements(case when ff.t = 'array' then ff.f
                                      when ff.t is null or ff.t = 'null' then '[]'::jsonb
                                      else jsonb_build_array(ff.f) end) el
   ) e
   where e.val <> '__none'
     and not exists (select 1 from m293_map x where x.old_id = e.val);
  if bad is not null then
    raise exception '293: unknown saved-view status facet(s) % — nothing was written', bad;
  end if;
end $$;

-- ── PART 2: what must not move ───────────────────────────────────────────────────────────
-- Items NOT done per board, live and archived counted apart — "done" by the label's kind, the
-- same rule as doneLabelIds/isItemDone (an untagged label, or no value, is not done). This is
-- what decides whether a row shows on Ongoing Projects, so it must be the same afterwards.
create temp table m293_before on commit drop as
select m.slug, (i.archived_at is not null) as archived, count(*) as total,
       count(*) filter (where not coalesce(
         (i.values ->> m.col_id::text) in (select l ->> 'id' from jsonb_array_elements(m.settings_before -> 'labels') l
                                           where l ->> 'kind' = 'done'), false)) as not_done
  from m293_cols m
  join public.pm_items i on i.board_id = m.board_id
 group by 1, 2;

-- Linked items whose label's client_status differs between the old and the new list. Reported,
-- never written: feedback_submissions is not touched by this file.
do $$
declare n int;
begin
  select count(*) into n
    from public.pm_items i
    join m293_cols m on m.board_id = i.board_id
    join m293_map x on x.old_id = i.values ->> m.col_id::text
   where i.feedback_submission_id is not null
     and jsonb_typeof(i.values -> m.col_id::text) = 'string'
     and (select l ->> 'client_status' from jsonb_array_elements(m.settings_before -> 'labels') l
           where l ->> 'id' = x.old_id limit 1)
         is distinct from
         (select l ->> 'client_status' from m293_canon c, jsonb_array_elements(c.labels) l
           where l ->> 'id' = x.new_id limit 1);
  raise notice '293: % linked item(s) now sit on a label with a different client_status (builders'' status is unchanged until someone next sets one)', n;
end $$;

-- ── PART 3: back up, then rewrite ────────────────────────────────────────────────────────
create table if not exists public.pm_status_backup_293 (
  kind         text not null check (kind in ('column', 'item', 'view')),
  row_id       uuid not null,
  board_slug   text not null,
  col_id       uuid not null,
  before       jsonb,
  backed_up_at timestamptz not null default now(),
  primary key (kind, row_id)
);
alter table public.pm_status_backup_293 enable row level security;
revoke all on public.pm_status_backup_293 from public, anon, authenticated;

insert into public.pm_status_backup_293 (kind, row_id, board_slug, col_id, before)
select 'column', m.col_id, m.slug, m.col_id, m.settings_before
  from m293_cols m
 where m.settings_before -> 'labels' is distinct from (select labels from m293_canon)
on conflict (kind, row_id) do nothing;

insert into public.pm_status_backup_293 (kind, row_id, board_slug, col_id, before)
select 'item', i.id, m.slug, m.col_id, i.values -> m.col_id::text
  from public.pm_items i
  join m293_cols m on m.board_id = i.board_id
  join m293_map x on x.old_id = i.values ->> m.col_id::text
 where jsonb_typeof(i.values -> m.col_id::text) = 'string'
   and x.new_id <> x.old_id
on conflict (kind, row_id) do nothing;

update public.pm_items i
   set values = jsonb_set(i.values, array[m.col_id::text], to_jsonb(x.new_id))
  from m293_cols m, m293_map x
 where i.board_id = m.board_id
   and jsonb_typeof(i.values -> m.col_id::text) = 'string'
   and x.old_id = i.values ->> m.col_id::text
   and x.new_id <> x.old_id;

-- Saved views, one at a time (148_pm_people.sql's facet loop is the pattern). Only the status
-- column's facet is touched; "__none" and anything that is not a string stay as they are.
do $$
declare
  v record;
  f jsonb;
  nf jsonb;
begin
  for v in
    select w.id, w.snap, m.col_id, m.slug
      from public.pm_views w
      join m293_cols m on m.board_id = w.board_id
     where w.snap -> 'facets' ? m.col_id::text
  loop
    f := v.snap -> 'facets' -> v.col_id::text;
    if jsonb_typeof(f) = 'string' then
      nf := case when f #>> '{}' = '__none' then f
                 else to_jsonb((select x.new_id from m293_map x where x.old_id = f #>> '{}')) end;
    elsif jsonb_typeof(f) = 'array' then
      select coalesce(jsonb_agg(case when jsonb_typeof(el) = 'string' and el #>> '{}' <> '__none'
                                     then to_jsonb((select x.new_id from m293_map x where x.old_id = el #>> '{}'))
                                     else el end order by o), '[]'::jsonb)
        into nf
        from jsonb_array_elements(f) with ordinality a(el, o);
    else
      nf := f;
    end if;
    if nf is distinct from f then
      insert into public.pm_status_backup_293 (kind, row_id, board_slug, col_id, before)
      values ('view', v.id, v.slug, v.col_id, f)
      on conflict (kind, row_id) do nothing;
      update public.pm_views
         set snap = jsonb_set(snap, array['facets', v.col_id::text], nf)
       where id = v.id;
    end if;
  end loop;
end $$;

update public.pm_columns c
   set settings = c.settings || jsonb_build_object('labels', (select labels from m293_canon)),
       updated_at = now()
  from m293_cols m
 where c.id = m.col_id
   and c.settings -> 'labels' is distinct from (select labels from m293_canon);

-- ── PART 4: assertions (any failure rolls the whole file back) ───────────────────────────
do $$
declare
  bad text;
  n int;
begin
  -- the three label arrays are equal, and equal to the list above
  select count(distinct c.settings -> 'labels') into n
    from public.pm_columns c join m293_cols m on m.col_id = c.id;
  if n <> 1 or exists (select 1 from public.pm_columns c join m293_cols m on m.col_id = c.id
                        where c.settings -> 'labels' is distinct from (select labels from m293_canon)) then
    raise exception '293: the three boards do not carry one identical status list';
  end if;

  -- exactly one intake label per board
  select string_agg(m.slug, ', ' order by m.slug) into bad
    from m293_cols m join public.pm_columns c on c.id = m.col_id
   where (select count(*) from jsonb_array_elements(c.settings -> 'labels') l
           where (l ->> 'intake') = 'true') <> 1;
  if bad is not null then
    raise exception '293: % does not have exactly one intake label', bad;
  end if;

  -- per-board not-done (and total) counts unchanged, live and archived apart
  select string_agg(coalesce(b.slug, a.slug) || case when coalesce(b.archived, a.archived) then ' (archived)' else '' end
                    || ' ' || coalesce(b.not_done, 0) || '->' || coalesce(a.not_done, 0), ', ') into bad
    from m293_before b
    full join (
      select m.slug, (i.archived_at is not null) as archived, count(*) as total,
             count(*) filter (where not coalesce(
               (i.values ->> m.col_id::text) in (select l ->> 'id' from public.pm_columns c, jsonb_array_elements(c.settings -> 'labels') l
                                                 where c.id = m.col_id and l ->> 'kind' = 'done'), false)) as not_done
        from m293_cols m join public.pm_items i on i.board_id = m.board_id
       group by 1, 2
    ) a on a.slug = b.slug and a.archived = b.archived
   where b.not_done is distinct from a.not_done or b.total is distinct from a.total;
  if bad is not null then
    raise exception '293: the not-done count changed on % — Ongoing Projects would gain or lose rows', bad;
  end if;

  -- nothing left on an old id
  select string_agg(distinct m.slug || ':' || left(i.values ->> m.col_id::text, 40), ', ') into bad
    from public.pm_items i join m293_cols m on m.board_id = i.board_id
   where jsonb_typeof(i.values -> m.col_id::text) = 'string'
     and not exists (select 1 from m293_canon c, jsonb_array_elements(c.labels) l where l ->> 'id' = i.values ->> m.col_id::text);
  if bad is not null then
    raise exception '293: item value(s) % are still off the list', bad;
  end if;

  select count(*) into n
    from public.pm_views v join m293_cols m on m.board_id = v.board_id
   cross join lateral jsonb_array_elements(case jsonb_typeof(v.snap -> 'facets' -> m.col_id::text)
                                             when 'array' then v.snap -> 'facets' -> m.col_id::text
                                             when 'string' then jsonb_build_array(v.snap -> 'facets' -> m.col_id::text)
                                             else '[]'::jsonb end) el
   where el #>> '{}' <> '__none'
     and not exists (select 1 from m293_canon c, jsonb_array_elements(c.labels) l where l ->> 'id' = el #>> '{}');
  if n <> 0 then
    raise exception '293: % saved-view facet value(s) are still off the list', n;
  end if;

  -- the backup is not readable from a browser
  if not (select relrowsecurity from pg_class where oid = 'public.pm_status_backup_293'::regclass) then
    raise exception '293: RLS is not enabled on pm_status_backup_293';
  end if;
end $$;

commit;

-- ── AFTER COMMIT ─────────────────────────────────────────────────────────────────────────
-- 1. Read back (expect only the nine canonical ids, in order, on all three boards; R2's per-board
--    not-done totals equal to the pre-read's):
--    with sc as (select distinct on (c.board_id) b.slug, c.board_id, c.id col, c.settings
--      from pm_columns c join pm_boards b on b.id=c.board_id
--      where c.type='status' and b.slug in ('bugs','features','working') order by c.board_id, c.position)
--    select sc.slug, x.ord, x.l->>'id', x.l->>'label', x.l->>'kind', x.l->>'client_status', x.l->>'intake'
--      from sc, jsonb_array_elements(sc.settings->'labels') with ordinality x(l,ord) order by 1,2;   -- R1
--    (R2 and R3: the pre-read's queries, unchanged.)
-- 2. Record it (re-read max(version) first; use the number you actually applied):
--    insert into supabase_migrations.schema_migrations (version, name)
--    values ('293', 'pm_canonical_statuses') returning version, name;
-- 3. From Ongoing Projects, set Done on an UNLINKED test Bug item and an unlinked test Feature
--    item: each leaves Ongoing and stays on its home board. Revert both.
