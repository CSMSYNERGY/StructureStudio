-- 270_paid_3d_unlock.sql — buying 3D turns 3D on, on the public designer as well as in the portal;
-- and the per-builder Advanced switch (client_settings.advanced_mode, PART 5).
--
-- ⛔ APPLY BY HAND, AFTER A HUMAN HAS READ IT. Pipe this file to `supabase db query --linked`
--    (NOT `--file`, which auth-fails, retries and still exits 0 — see 232's header), then record it:
--      insert into supabase_migrations.schema_migrations (version, name) values ('270', '270_paid_3d_unlock');
--    NEVER `supabase db push`. The file carries its own begin;/commit; so every check below takes the
--    whole migration with it if it fails.
--    `db query` NEVER prints a NOTICE (it prints the rows of the last statement that returns any), so
--    every RAISE NOTICE below is for psql and the tests only. What the apply shows is THE RECORD, one
--    row just before the commit (see its header at the end): read it, and keep it with the ledger
--    insert. No row printed means the file did not run. To see the same row first and change
--    nothing, pipe the file with its last `commit;` swapped for `rollback;` (a dry run).
--
-- ── WHY ──────────────────────────────────────────────────────────────────────────────────
-- Carolyn, 2026-09-16 (live call, a builder signing up): the builder bought 3D View, Billing showed
-- it active, and the designer stayed locked until she switched 3D on by hand in the back end. A
-- second builder hit the same gap on 2026-08-27. Her rule since 2026-08-20 (audit 3D-02): "if we give
-- them access, they can see it in both places", the portal and the public designer.
--
-- Two readers decide whether a builder has 3D, and both only ever looked at client_feature_grants:
--   * the portal, through portal-billing's `entitlement.granted` (12-shell.jsx view3dUnlocked);
--   * the PUBLIC designer, through get_config's `view3d` (migration 110), which is an EXISTS over
--     client_feature_grants and nothing else.
-- A purchase writes billing_subscriptions, never a grant, so a paying builder's 3D stayed dark in
-- both places until an operator added a grant by hand. Both payers to date hold such a hand grant
-- (expires_at NULL), which is why nobody is locked out TODAY; the next buyer would be.
--
-- ── SHAPE ────────────────────────────────────────────────────────────────────────────────
--   PART 1   public.ss_view3d_paid(client_id) — does this tenant hold a USABLE 3D subscription?
--   PART 2   blast radius: snapshot every tenant's get_config, NOTICE whose view3d will flip
--   PART 3   get_config: `'view3d', exists(<grant>)` becomes `exists(<grant>) or ss_view3d_paid(…)`,
--            SPLICED into the live body (232's mechanism), never rewritten
--   PART 4   checks: every tenant's get_config is unchanged except a false→true view3d; grants hold
--   PART 5   client_settings.advanced_mode boolean not null default false — the Advanced switch
--            (see its own header below; it is the same batch, not the same feature)
--   RECORD   one row the CLI prints: who gained 3D by paying, the splice and grants, Advanced count
--
-- The PORTAL half is not here: portal-billing's entitlement gains `paid` (features a usable
-- subscription confers, the Suite expanded) and 12-shell.jsx opens 3D on granted OR paid.
--
-- ── THE RULE, AND WHY IT IS A COPY ───────────────────────────────────────────────────────
-- "Usable" must mean exactly what portal-billing's featureState and _shared/featureCheck.ts's
-- usableSub mean, or the public designer and the portal disagree about the same builder:
--   active                                                            → usable
--   past_due, past_due_since + 7 days > now (no timestamp: from now)  → usable (the grace period)
--   cancelled, paid-through > now                                     → usable (the prepaid period)
--   anything else (paused, past_due outside grace, cancelled and done) → not
-- Paid-through is _shared/billingPeriods.ts paidThroughOf: current_period_end rolled forward by
-- whole billing intervals (calendar months or years, end-of-month clamped, in UTC) until it passes
-- canceled_at (now(), if somehow unset), at most 240 steps. A NULL current_period_end is a legacy
-- bill-in-arrears row: nothing prepaid, not usable. Postgres's `timestamp + interval '1 month'`
-- clamps the end of the month exactly as addInterval does (Jan 31 → Feb 28, and on from the 28th),
-- and the arithmetic is done on UTC wall-clock timestamps so the session TimeZone cannot move a
-- boundary by a day. The 7 days are 168 hours: GRACE_DAYS * 86400000 ms, no DST.
-- ⚠️ Duplication ledger — change together: featureCheck.ts (GRACE_DAYS, BUNDLE_FEATURES),
-- portal-billing/index.ts (the same two), billingPeriods.ts (paidThroughOf), and this function.
-- tests/sql/migration270.test.cjs runs the SQL against the real paidThroughOf on random dates.
--
-- Plans that confer 3D: feature view_3d, and full_suite (BUNDLE_FEATURES). Retired plans
-- (active = false) still count, as they do in portal-billing's planById: a plan row is a historical
-- fact, only its availability expires.
--
-- Deliberately NOT here: internal_account / billing_exempt. get_config never read them, those
-- accounts hold grants, and widening the public page for a flag is a separate decision.
--
-- ── WHAT DOES NOT CHANGE ─────────────────────────────────────────────────────────────────
--   * No grant is written, moved or expired. The hand grants stay exactly as they are; whether to
--     take them off now that paying is enough is Carolyn's call, not this file's.
--   * Every tenant's get_config output is identical except where view3d flips false → true, and
--     PART 4 proves it against the snapshot PART 2 takes, raising (and so rolling back) otherwise.
--     Expected flips on 2026-10-05: NONE (both payers already hold grants).
--   * No table, policy or trigger, and one column only (PART 5), off for every row it lands on.
--
-- ── SAFE WITH WHAT IS LIVE ───────────────────────────────────────────────────────────────
-- Beta and production share this database, and get_config is the boot read for every tenant's
-- public designer, so this goes live on PRODUCTION's public pages the moment it commits. That is
-- the intent (the production public designer is fixed by this file alone). The splice keeps
-- get_config's ACL, owner, SECURITY DEFINER and search_path (CREATE OR REPLACE); PART 4 re-asserts
-- anon EXECUTE, because a designer that cannot read its config is every tenant's page down.
--
-- ── GRANTS ───────────────────────────────────────────────────────────────────────────────
-- ss_view3d_paid reads billing tables the browser roles cannot, so it is SECURITY DEFINER and is
-- revoked from public, anon and authenticated (Supabase's default privileges hand new functions to
-- all three). get_config reaches it as get_config's OWNER (it is SECURITY DEFINER too), which PART 4
-- checks; service_role keeps EXECUTE, 263's posture.
--
-- ── SPLICED, NOT REWRITTEN ───────────────────────────────────────────────────────────────
-- 110's rule, 232's mechanism: read the LIVE body, insert one expression after one anchor, execute.
-- get_config is ~17.7 KB and has been extended by splices on several branches; pasting a body from
-- a file would silently drop whatever landed since. Three guards, and nothing rather than half:
--   1. Already spliced (`ss_view3d_paid` in the body) → notice and skip. A re-run is safe.
--   2. The anchor — the last line of the grant EXISTS and the paren that closes it — must occur
--      EXACTLY ONCE. Confirmed on the live project 2026-10-05: count 1, body 17768 chars, md5
--      c3f1cd24f9423da3c648a5f4fc417a26. The newline inside it is chr(10), not a literal line
--      break: this file is checked out CRLF on Windows, and a CRLF anchor never matches.
--   3. The new body is longer by exactly the inserted text: one insertion, no deletion.
-- ⚠️ Batch Y2 (quote corner views) splices get_config too. Each splice re-derives its anchor from
-- the live body at apply time, so the two can apply in either order.
--
-- ── NUMBERING ────────────────────────────────────────────────────────────────────────────
-- Live ledger 2026-10-05: 269 is the newest, 248 and 268 are held. 270 is this batch's number, for
-- both of its items (the plan had 271 for the Advanced column; it rides here instead, so 271 is free).
-- Confirm at apply time that the ledger does not already show 270.
--
-- ── ORDER ────────────────────────────────────────────────────────────────────────────────
-- This file FIRST, then portal-billing, then portal-settings, then the portal to beta.
-- portal-billing does NOT have to wait for this file: it reads client_settings.advanced_mode on its
-- own and fail-soft (a database without the column reads as Advanced off, with a warning), outside
-- its fatal settings read, and `paid` never needed this file. portal-settings' save_advanced_mode
-- writes the column, so it goes after (before, that one action would answer 500 and nothing else
-- would). The production portal ignores `paid` and `advancedMode` until it is promoted; the
-- production PUBLIC designer is fixed by this file alone.
--
-- ── ROLLBACK — in THIS order ─────────────────────────────────────────────────────────────
--   1. Un-splice first (a dropped function named by a LANGUAGE sql body fails every call, and that
--      body is every public designer's first read):
--        do $$ declare s text := pg_get_functiondef('public.get_config(text)'::regprocedure);
--               a text := ' or public.ss_view3d_paid(cc.client_id)';
--        begin if position(a in s) = 0 then raise exception 'splice not found'; end if;
--              execute replace(s, a, ''); end $$;
--   2. Then: drop function public.ss_view3d_paid(text);
--   3. Then delete the ledger row. A paying builder without a hand grant loses 3D on the public
--      page again; check the RECORD's view3d_gained_by_paying before doing this.
--   PART 5 on its own: put back the portal-settings without save_advanced_mode (with the column
--   gone the switch would answer an error, nothing else), then
--        alter table public.client_settings drop column advanced_mode;
--   portal-billing needs no redeploy for this: it reads the column fail-soft. Every builder who
--   switched Advanced on loses it; our own account keeps it (internal_account).

begin;

-- CREATE OR REPLACE on get_config takes a lock on the function, and PART 5's ALTER TABLE takes an
-- ACCESS EXCLUSIVE lock on client_settings (brief: a constant default is a catalog change, no
-- rewrite), which portal-billing reads on every status call. A hung apply must give up rather than
-- sit in front of every designer's boot read and every portal's first call.
set local lock_timeout = '5s';

-- ── PART 1. ss_view3d_paid ───────────────────────────────────────────────────────────────
create or replace function public.ss_view3d_paid(p_client_id text)
returns boolean
language plpgsql
stable
security definer
set search_path = ''
as $fn$
declare
  r       record;
  v_step  interval;
  v_end   timestamp;   -- UTC wall clock: addInterval works on getUTC*, and so does this
  v_until timestamp;
  v_now   timestamp := now() at time zone 'UTC';
  v_i     integer;
begin
  if p_client_id is null then
    return false;
  end if;
  for r in
    select s.status, s.current_period_end, s.canceled_at, s.past_due_since, p.billing_interval
      from public.billing_subscriptions s
      join public.billing_plans p on p.id = s.plan_id
     where s.client_id = p_client_id
       and p.feature in ('view_3d', 'full_suite')
  loop
    if r.status = 'active' then
      return true;
    elsif r.status = 'past_due' then
      -- graceEndOf: no timestamp → grace from now, generous rather than an instant lockout.
      if coalesce(r.past_due_since, now()) + interval '168 hours' > now() then
        return true;
      end if;
    elsif r.status = 'cancelled' and r.current_period_end is not null then
      -- paidThroughOf: /^(year|annual)/ on the lower-cased interval is yearly, anything else monthly.
      v_step  := case when lower(coalesce(r.billing_interval, '')) ~ '^(year|annual)'
                      then interval '1 year' else interval '1 month' end;
      v_end   := r.current_period_end at time zone 'UTC';
      v_until := coalesce(r.canceled_at, now()) at time zone 'UTC';
      v_i := 0;
      -- Bounded like the original: one step per elapsed interval, at most 240.
      while v_i < 240 and v_end <= v_until loop
        v_end := v_end + v_step;
        v_i := v_i + 1;
      end loop;
      if v_end > v_now then
        return true;
      end if;
    end if;
  end loop;
  return false;
end
$fn$;

comment on function public.ss_view3d_paid(text) is
  'True iff the tenant holds a USABLE view_3d or full_suite subscription right now: active; past_due '
  'inside the 7-day grace; or cancelled but inside the period already paid for (billingPeriods.ts '
  'paidThroughOf). The same rule as portal-billing featureState and _shared/featureCheck.ts usableSub. '
  'Read by get_config''s view3d (270). Not callable by the browser roles.';

revoke execute on function public.ss_view3d_paid(text) from public, anon, authenticated;
grant  execute on function public.ss_view3d_paid(text) to service_role;

-- ── PART 2. Blast radius, and the snapshot PART 4 compares against ───────────────────────
-- Every tenant's get_config as it is BEFORE the splice. jsonb, not text: PART 4 compares the
-- whole object with view3d taken out, so a change anywhere else is caught, whatever it is.
create temp table m270_before on commit drop as
  select cc.client_id, public.get_config(cc.client_id) as cfg
    from public.client_configs cc;

do $radius$
declare
  v_flip  text;
  v_nflip integer;
  v_both  text;
begin
  -- Paying, and no live grant: these are the tenants whose public designer gains 3D.
  select string_agg(cc.client_id, ', ' order by cc.client_id), count(*)
    into v_flip, v_nflip
    from public.client_configs cc
   where public.ss_view3d_paid(cc.client_id)
     and not exists (select 1 from public.client_feature_grants g
                      where g.client_id = cc.client_id and g.feature = 'view_3d'
                        and (g.expires_at is null or g.expires_at > now()));
  -- Paying AND granted: unchanged today, but these keep 3D after cancelling while the grant stands.
  select string_agg(cc.client_id, ', ' order by cc.client_id)
    into v_both
    from public.client_configs cc
   where public.ss_view3d_paid(cc.client_id)
     and exists (select 1 from public.client_feature_grants g
                  where g.client_id = cc.client_id and g.feature = 'view_3d'
                    and (g.expires_at is null or g.expires_at > now()));
  raise notice '270: view3d flips false -> true for % tenant(s): %', v_nflip, coalesce(v_flip, '(none)');
  raise notice '270: paying AND holding a hand grant (no change; the grant outlives a cancellation): %', coalesce(v_both, '(none)');
end
$radius$;

-- ── PART 3. get_config: view3d = grant OR usable subscription ────────────────────────────
do $splice$
declare
  v_src    text := pg_get_functiondef('public.get_config(text)'::regprocedure);
  -- The grant EXISTS's last condition and the paren that closes it. chr(10), not a line break in
  -- this file: see the header (CRLF checkouts).
  v_anchor text := 'and (g.expires_at is null or g.expires_at > now())' || chr(10) || '    )';
  v_add    text := ' or public.ss_view3d_paid(cc.client_id)';
  v_hits   integer;
  v_new    text;
begin
  -- GUARD 1 — idempotent.
  if position('ss_view3d_paid' in v_src) > 0 then
    raise notice '270: get_config already reads ss_view3d_paid — nothing to splice';
    return;
  end if;

  -- GUARD 2 — the anchor is unique, and it is the view3d block's.
  v_hits := (length(v_src) - length(replace(v_src, v_anchor, ''))) / length(v_anchor);
  if v_hits <> 1 then
    raise exception '270: anchor found % time(s), expected exactly 1 — get_config has changed shape; re-derive the anchor from a fresh pg_get_functiondef before retrying', v_hits;
  end if;
  if position($v$'view3d', exists ($v$ in v_src) = 0
     or position($v$'view3d', exists ($v$ in v_src) > position(v_anchor in v_src) then
    raise exception '270: the anchor is not inside the view3d block — get_config has changed shape';
  end if;

  v_new := replace(v_src, v_anchor, v_anchor || v_add);

  -- GUARD 3 — one insertion, no deletion.
  if length(v_new) <> length(v_src) + length(v_add) then
    raise exception '270: spliced body is % chars, expected % — refusing to execute', length(v_new), length(v_src) + length(v_add);
  end if;

  execute v_new;
  raise notice '270: spliced ss_view3d_paid into get_config view3d (% -> % chars)', length(v_src), length(v_new);
end
$splice$;

-- ── PART 4. Checks: raise (and so roll the whole file back) rather than commit a surprise ─
do $check$
declare
  v_body    text := pg_get_functiondef('public.get_config(text)'::regprocedure);
  v_owner   text;
  v_bad     text;
  v_flipped text;
  v_cfg     record;
begin
  -- The helper: there, definer, search_path pinned, and closed to the browser roles.
  if not exists (
    select 1 from pg_proc p
     where p.oid = 'public.ss_view3d_paid(text)'::regprocedure
       and p.prosecdef
       and p.provolatile = 's'
       and p.proconfig @> array['search_path=""']
  ) then
    raise exception '270: ss_view3d_paid is not STABLE SECURITY DEFINER with an empty search_path';
  end if;
  if (select p.proacl is null from pg_proc p where p.oid = 'public.ss_view3d_paid(text)'::regprocedure)
     or exists (select 1 from pg_proc p, aclexplode(p.proacl) a
                 where p.oid = 'public.ss_view3d_paid(text)'::regprocedure
                   and a.grantee = 0 and a.privilege_type = 'EXECUTE') then
    raise exception '270: PUBLIC can still EXECUTE ss_view3d_paid';
  end if;
  if has_function_privilege('anon', 'public.ss_view3d_paid(text)', 'execute')
     or has_function_privilege('authenticated', 'public.ss_view3d_paid(text)', 'execute') then
    raise exception '270: a browser role can EXECUTE ss_view3d_paid';
  end if;
  if not has_function_privilege('service_role', 'public.ss_view3d_paid(text)', 'execute') then
    raise exception '270: service_role lost EXECUTE on ss_view3d_paid';
  end if;

  -- get_config: spliced once, still callable by anon, and its OWNER (whom it runs as) can call the
  -- helper — the revoke above must not have locked get_config out of its own view3d.
  if (length(v_body) - length(replace(v_body, 'ss_view3d_paid', ''))) / length('ss_view3d_paid') <> 1 then
    raise exception '270: get_config does not name ss_view3d_paid exactly once after the splice';
  end if;
  if not has_function_privilege('anon', 'public.get_config(text)', 'execute') then
    raise exception '270: anon lost EXECUTE on get_config — every public designer would fail to load';
  end if;
  select p.proowner::regrole::text into v_owner from pg_proc p where p.oid = 'public.get_config(text)'::regprocedure;
  if not has_function_privilege(v_owner, 'public.ss_view3d_paid(text)', 'execute') then
    raise exception '270: get_config runs as %, who cannot EXECUTE ss_view3d_paid', v_owner;
  end if;

  -- Every tenant: identical but for view3d, and view3d only ever false -> true, and only where the
  -- tenant pays without a grant. Dynamic SQL so no plan cached before the splice is reused.
  v_bad := null;
  v_flipped := null;
  for v_cfg in execute
    'select b.client_id, b.cfg as before, public.get_config(b.client_id) as after from m270_before b order by b.client_id'
  loop
    if v_cfg.after is not distinct from v_cfg.before then
      continue;
    end if;
    if (v_cfg.after - 'view3d') is distinct from (v_cfg.before - 'view3d')
       or coalesce((v_cfg.before ->> 'view3d')::boolean, false)
       or not coalesce((v_cfg.after ->> 'view3d')::boolean, false)
       or not public.ss_view3d_paid(v_cfg.client_id) then
      v_bad := concat_ws(', ', v_bad, v_cfg.client_id);
    else
      v_flipped := concat_ws(', ', v_flipped, v_cfg.client_id);
    end if;
  end loop;
  if v_bad is not null then
    raise exception '270: get_config changed beyond a false -> true view3d for: %', v_bad;
  end if;
  if (select count(*) from m270_before) <> (select count(*) from public.client_configs) then
    raise exception '270: the tenant count moved during the apply — run it again';
  end if;
  raise notice '270: checks hold; every tenant''s get_config is unchanged except view3d now true for: %', coalesce(v_flipped, '(none)');
end
$check$;

-- ── PART 5. client_settings.advanced_mode — the per-builder Advanced switch ──────────────
-- Carolyn, 2026-09-28 (the Attach & Advanced call): the Advanced page is "only available in
-- Structure Studio for us yet". Ahsan: when it launches, builders "just have to go into settings
-- and ... turn on the advanced mode to access this tab, so everybody is not going to see." Carolyn:
-- "Yep, yep, no, that's good."
--
-- One boolean per builder, OFF on every row it lands on, so nobody sees anything new until an owner
-- or admin switches it on in Settings → Designer (portal-settings save_advanced_mode). portal-billing
-- sends it as the entitlement's `advancedMode`, and ssAdvancedOn (portal/01-core.jsx) is the one rule
-- that reads it. Free: no plan, no charge, no grant. The page itself still needs 3D.
--
-- Our own account is NOT written: it has the page through internal_account (`reason: "internal"`)
-- whatever this column says, and the switch shows on and locked there.
--
-- Read by portal-billing and written by portal-settings, both as service_role. client_settings is
-- closed to the browser roles (ACL postgres + service_role, RLS on with no policies: live
-- 2026-10-05), a new column inherits that, and the checks below hold it to it. get_config does not
-- change: the PUBLIC designer has no Advanced page, so the anon config never carries this. The check
-- below proves no tenant's config moved anyway.
--
-- Re-runnable: a column that is already there keeps every value builders have set; only its shape
-- is checked again.
create temp table m270_adv_before on commit drop as
  select cc.client_id, public.get_config(cc.client_id) as cfg
    from public.client_configs cc;

do $adv$
declare
  v_had   boolean;
  v_rows  integer;
  v_on    text;
  v_moved text;
  v_role  text;
begin
  select exists (select 1 from information_schema.columns
                  where table_schema = 'public' and table_name = 'client_settings' and column_name = 'advanced_mode')
    into v_had;
  if v_had then
    raise notice '270: client_settings.advanced_mode is already there — every value in it is kept';
  else
    alter table public.client_settings add column advanced_mode boolean not null default false;
  end if;

  comment on column public.client_settings.advanced_mode is
    'The builder''s Advanced mode switch (Settings → Designer, portal-settings save_advanced_mode, owner '
    'or admin). On: the portal shows the Advanced page under Designer (portal-billing sends it as '
    'entitlement.advancedMode; portal/01-core.jsx ssAdvancedOn reads it). Off by default. Free. '
    'internal_account has the page regardless. Migration 270.';

  -- Its shape: boolean, NOT NULL, default false.
  if not exists (select 1 from information_schema.columns
                  where table_schema = 'public' and table_name = 'client_settings' and column_name = 'advanced_mode'
                    and data_type = 'boolean' and is_nullable = 'NO' and column_default = 'false') then
    raise exception '270: client_settings.advanced_mode is not boolean NOT NULL DEFAULT false';
  end if;

  -- Freshly added means off for everyone. (A re-run keeps what builders chose, so this is first-run only.)
  select count(*) into v_rows from public.client_settings;
  select string_agg(client_id, ', ' order by client_id) into v_on from public.client_settings where advanced_mode;
  if not v_had and v_on is not null then
    raise exception '270: advanced_mode was just added and is already on for: %', v_on;
  end if;

  -- Closed to the browser roles, open to the service role that reads and writes it.
  foreach v_role in array array['anon', 'authenticated'] loop
    if has_column_privilege(v_role, 'public.client_settings', 'advanced_mode', 'SELECT')
       or has_column_privilege(v_role, 'public.client_settings', 'advanced_mode', 'INSERT')
       or has_column_privilege(v_role, 'public.client_settings', 'advanced_mode', 'UPDATE') then
      raise exception '270: % can read or write client_settings.advanced_mode', v_role;
    end if;
  end loop;
  if not (has_column_privilege('service_role', 'public.client_settings', 'advanced_mode', 'SELECT')
          and has_column_privilege('service_role', 'public.client_settings', 'advanced_mode', 'INSERT')
          and has_column_privilege('service_role', 'public.client_settings', 'advanced_mode', 'UPDATE')) then
    raise exception '270: service_role cannot read and write client_settings.advanced_mode (portal-billing / portal-settings)';
  end if;

  -- No tenant's public config moved. Dynamic SQL so no plan cached before the ALTER is reused.
  execute 'select string_agg(b.client_id, '', '' order by b.client_id) from m270_adv_before b
            where public.get_config(b.client_id) is distinct from b.cfg'
    into v_moved;
  if v_moved is not null then
    raise exception '270: adding advanced_mode changed get_config for: %', v_moved;
  end if;

  raise notice '270: advanced_mode % on client_settings (% row(s)); Advanced mode is on for: %',
    case when v_had then 'kept' else 'added, off,' end, v_rows, coalesce(v_on, '(none)');
end
$adv$;

-- ── THE RECORD — the one thing `db query` prints ─────────────────────────────────────────
-- The NOTICEs above never reach the CLI (checked 2026-10-05, read-only: it prints the rows of the
-- last statement that returns any, even with a commit or rollback after it). So this row is the
-- apply's report, and it sits BEFORE the commit so a dry run (last `commit;` swapped for
-- `rollback;`) prints the same row and leaves nothing behind. Expected on 2026-10-05:
--   view3d_gained_by_paying  '(none)'  — the public designers that gain 3D by paying alone
--   paying_and_hand_granted  the payers who also hold a hand grant (unchanged; the grant outlives a
--                            cancellation, which is Carolyn's call)
--   get_config_splices 1, anon_reads_get_config true, browser_can_call_helper false
--   advanced_mode_on 0 on a first apply (a re-run keeps what builders chose)
-- Anything else: roll back (see ROLLBACK above) before recording the ledger row.
select
  '270' as migration,
  coalesce((select string_agg(cc.client_id, ', ' order by cc.client_id)
              from public.client_configs cc
             where public.ss_view3d_paid(cc.client_id)
               and not exists (select 1 from public.client_feature_grants g
                                where g.client_id = cc.client_id and g.feature = 'view_3d'
                                  and (g.expires_at is null or g.expires_at > now()))), '(none)') as view3d_gained_by_paying,
  coalesce((select string_agg(cc.client_id, ', ' order by cc.client_id)
              from public.client_configs cc
             where public.ss_view3d_paid(cc.client_id)
               and exists (select 1 from public.client_feature_grants g
                            where g.client_id = cc.client_id and g.feature = 'view_3d'
                              and (g.expires_at is null or g.expires_at > now()))), '(none)') as paying_and_hand_granted,
  (length(pg_get_functiondef('public.get_config(text)'::regprocedure))
     - length(replace(pg_get_functiondef('public.get_config(text)'::regprocedure), 'ss_view3d_paid', '')))
     / length('ss_view3d_paid') as get_config_splices,
  has_function_privilege('anon', 'public.get_config(text)', 'execute') as anon_reads_get_config,
  (has_function_privilege('anon', 'public.ss_view3d_paid(text)', 'execute')
     or has_function_privilege('authenticated', 'public.ss_view3d_paid(text)', 'execute')) as browser_can_call_helper,
  (select count(*) from public.client_settings where advanced_mode)::int as advanced_mode_on;

commit;

-- After this: config.view3d = a live view_3d grant OR a usable view_3d / full_suite subscription.
-- Nothing else in get_config moved. client_settings.advanced_mode exists, off for every builder.
