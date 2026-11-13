-- 389: THE PUBLIC SIDE of plans as data (386 to 388). What a company's own customers are offered.
--
-- 387 made the portal obey the tab map and 388 made the server obey it. Both are about the builder's
-- own staff. This is the third reader: the pages a builder's CUSTOMERS open with no login (the online
-- lot shop, a website form, the meeting booking page). It adds two functions and changes one line of
-- one existing function, and it changes nothing for any company that is not named for the server.
--
--   access_for_public(client)          null = the old rules (not named, or anything malformed), else
--                                      { "mode": "block" | "report", "holds": bool,
--                                        "blocked": { tab: true | false, one per catalogue tab } }.
--                                      Read by the edge functions (_shared/accessPublic.ts).
--   access_public_blocked(client, tab) true ONLY when the answer above says mode "block" and
--                                      blocked[tab] is true. For use INSIDE the public database
--                                      functions, which cannot write a report row and must never
--                                      fail: it cannot raise, and every doubt answers false.
--   get_public_shop(text)              one condition added to its "this shop is off" test, so a
--                                      blocked shop answers the same not_found a shop that is
--                                      switched off answers. Nobody can tell the two apart.
--
-- WHO IS NAMED. The same lists as 388, read the same way, and no new switch: server_all or
-- server_clients = block, server_report = report, block wins. A company named only for the PORTAL
-- (387's `clients` / `all`) is not named here.
--
-- WHY THE PUBLIC RULE IS NOT THE SERVER RULE. On the server, a tab that is not exactly "on" is not
-- had. That is right for a builder's staff: the portal already locks a company that has stopped
-- paying, so the server refusing the same things takes nothing more away. The public pages are
-- different. No public page reads the billing gate today: a builder whose subscription lapsed keeps
-- its shop and its forms, and on the tab map that builder resolves nearly every tab "hidden" (it
-- holds no plan). The server rule would darken those pages on the day it was named, which no rule
-- today does and nobody decided. (Booking is the one public page with a paid check of its own:
-- book-public asks for the Customer Hub and already answers not_found to a lapsed builder. This
-- migration neither adds to that check nor takes it away.) So for the public a tab is BLOCKED when:
--
--   1. its state is "off": an operator switched it off for this company (a client_modules row), or
--      the company's shape rules it out (a company that sells no sheds has no lot shop). This wins
--      for every company, lapsed or not; or
--   2. the company HOLDS a plan and the tab's state is not "on". A company that is on a plan gets
--      what the plan says, padlocked tabs included (a padlock is an offer to buy, not the feature).
--
-- "Holds a plan" is a fact about the COMPANY. It is read from what the company holds, and never from
-- which reasons happened to survive on its tabs (access_resolve_detail.source): the resolver is
-- first match wins, so a plan whose every tab is claimed by an earlier step (an operator's row, the
-- no-sheds shape, an older switch such as jack_on or phone_status) leaves no plan reason on any row,
-- and the company is on that plan all the same. It is 386's own rule (the resolver's `held` and
-- `held_ok`, and steps 3 and 6 of its header), column for column and status for status:
--
--   a. a usable subscription (386's access_usable_plans) to a plan that is not a draft; or
--   b. an operator's assignment that has not expired (client_access_plans), to a plan that is not a
--      draft; or
--   c. a dated free period that is still running (billing_exempt_until), while a plan marked
--      free_period is not a draft; or
--   d. our own account or Non-billable (internal_account, billing_exempt), while an active public
--      plan includes at least one tab, which is all those two confer; or
--   e. the phone-only shape (phone_only), which IS a plan: Phone + Contacts.
--
-- A company holding none of those is the lapsed builder: it is blocked only where rule 1 says so,
-- and otherwise keeps what it has today. An older switch, a 3D comp and an operator's ON for one tab
-- are not a plan, and neither is a draft plan, an assignment that has ended or a free period that is
-- over.
--
-- Three things follow from reading it this way, and they are meant:
--   * One plan, one answer. Two companies on the same plan read the same whichever resolver step
--     claims their tabs: the one that also has the older switches on is not mistaken for a lapsed
--     builder.
--   * A held plan with no tab rows at all still counts as held (386 holds it too; it only confers
--     nothing), so every tab of that company that is not on is blocked. A plan that is not a draft
--     should have its rows.
--   * THE HELD RULE NOW LIVES IN TWO PLACES: 386's access_resolve_detail and access_for_public
--     here. 386 exposes the subscription part as a function (access_usable_plans, called here, not
--     copied) but not the held set, so b to e are written out again. Change the two together;
--     tests/sql/migration389.test.cjs holds a to e against made-up companies.
--
-- THIS ONLY STOPS OFFERING. It is read where a customer STARTS something (opens the shop, loads a
-- form, asks for meeting times or books one). A NEW booking is the one typed request that IS asked:
-- it is new work on a host's calendar, book-public's own Customer Hub check already refuses it the
-- same way, and an unasked book could be posted without the page. A form submit, a purchase request,
-- a payment, and a booking read, moved or cancelled by its token are never asked. That is the
-- callers' job to keep true, and their tests pin it.
--
-- FAILS TO "NOT BLOCKED". A missing row, a malformed value, a null id, an unknown tab and a database
-- error all answer null / false, and the callers treat a failed call the same way. A report-mode
-- company is never blocked in the database (get_public_shop cannot file a report row, so for it
-- report mode simply means "not yet").
--
-- THE SPLICE. get_public_shop is edited in place, the way 270 and 344 edit live functions: read the
-- LIVE body, change one line, execute, check. Never pasted from a file, so nothing that landed since
-- can be dropped. The body this was derived from, dumped live on 2026-11-13: pg_get_functiondef
-- length 5111, md5 173586fb0d1bfb62659a6cb4b2355704, which is 314's text unchanged. The one line
--     if not found or not v_shop.enabled then
-- becomes
--     if not found or not v_shop.enabled or public.access_public_blocked(p_client_id, 'inventory') then
-- and the body this writes is length 5169, md5 c9032d3d7f9f726a5505012f18dba4d6.
-- Guards, and nothing rather than half (the splice and every check after it are ONE do block, so a
-- raise undoes the execute):
--   1. already spliced (the body names access_public_blocked): notice and skip. A re-run is safe.
--   2. the line must be in the live body EXACTLY once, or the apply stops and says so.
--   3. the new body is longer by exactly the added text, names the helper exactly once, is still
--      SECURITY DEFINER with an empty search_path, and anon can still execute it.
--   4. get_public_shop's OWNER (whom it runs as) can execute the helper the browser roles cannot.
--   5. every shop answers exactly what it answered before, except the ones this blocks, and those
--      answer not_found. With nobody named in block mode that is every shop, unchanged. The two
--      looks are two statements, so on the live database a builder's edit or a sale that commits
--      between them reads as a change as well. The message says so and names the shops; nothing
--      has changed, and applying again is safe.
--   6. THE APPLY ITSELF CLOSES NO SHOP unless it is told it may. A company that is ALREADY named in
--      block mode (server_clients, or server_all) and has an open shop its plan or shape blocks
--      would lose that shop the moment this commits, on beta and production alike (they share one
--      database), and with no report phase first (the database cannot file a report row). So the
--      apply stops, names those companies and changes nothing. Then either take them out of the
--      list, apply, and name them again on the day their shop should close; or accept it by
--      running this first, in the SAME call as this file, with the count the message gave:
--          select set_config('ss.m389_shops_may_close', '1', true);
--      It guards this one apply and nothing reads it afterwards: it is not a new switch. A re-run
--      over an already spliced function has nothing to compare and skips checks 5 and 6.
-- The anchor is one line with no line break in it: this file is checked out CRLF on Windows.
--
-- BEFORE THE THREE EDGE FUNCTIONS DEPLOY (lead-form, book-public, shop-checkout). They obey the same
-- lists from the minute they are live, so a company already in server_clients gets no report phase
-- for its forms, its booking page or its cart: 388's report rows were about its staff, not its
-- customers. Look first. After this file is applied, this lists what each such company's customers
-- would stop being offered (true = blocked); under server_all, ask access_for_public per company:
--     select k as company, p -> 'holds' as holds, p -> 'blocked' -> 'inventory' as shop,
--            p -> 'blocked' -> 'forms' as forms, p -> 'blocked' -> 'meetings' as booking
--       from public.access_config c,
--            jsonb_array_elements_text(case when jsonb_typeof(c.value -> 'server_clients') = 'array'
--                                           then c.value -> 'server_clients' else '[]'::jsonb end) k,
--            public.access_for_public(k) p
--      where c.key = 'enforce';
-- Anyone it shows blocked where that would be a surprise: move them to server_report until it is not.
--
-- COST. For a company that is not named: one read of the single access_config row, on each shop
-- load. For a named company the resolver runs on each shop load, uncached (SQL has no cache), and
-- the subscription read (access_usable_plans) runs twice: once inside the resolver and once for
-- "holds" (once only because that subquery ends in `offset 0`; the test counts both). The edge
-- functions cache their own read for 30 seconds.
--
-- SECURITY. Both functions are SECURITY DEFINER with an empty search_path because they read the
-- service-only access tables, and EXECUTE is revoked from public, anon and authenticated: a browser
-- can neither read a company's plan nor ask whether a competitor's shop is blocked. get_public_shop
-- keeps the grants it has (anon and authenticated execute it, as 310 set).
--
-- The repo is public: no client identifiers in here. The companies named in the row are data.
--
-- APPLY THE WHOLE FILE IN ONE CALL (one transaction), after 386 to 388. Nothing here needs a deploy
-- first: the edge functions that read access_for_public treat a database without it as "not named".
--
-- Rollback, in THIS order (get_public_shop names the helper, and a body that names a dropped
-- function fails every call, which is every shop page down):
--   1. do $$ declare s text := pg_get_functiondef('public.get_public_shop(text)'::regprocedure);
--             a text := ' or public.access_public_blocked(p_client_id, ''inventory'')';
--      begin if position(a in s) = 0 then raise exception 'splice not found'; end if;
--            execute replace(s, a, ''); end $$;
--   2. drop function if exists public.access_public_blocked(text, text);
--   3. drop function if exists public.access_for_public(text);
-- After step 1 the body is 314's again (length 5111, md5 173586fb0d1bfb62659a6cb4b2355704).

-- ── 1. The public answer for one company ──────────────────────────────────────────────────────
-- Everything runs only inside the named branch. `holds` is a fact about the whole company, so it is
-- worked out first, from what the company holds (a to e in the header, which are 386's `held`,
-- `held_ok`, `blanket` and phone-only flag: keep them equal to 386), and then applied to each tab.
-- It is worked out ONCE: the one-row subquery ends in `offset 0` so it cannot be copied into each
-- place it is read. It never looks at the resolver's reasons. The resolver itself runs once, for the states; with no
-- rows from it (an empty catalogue) the answer is still an object, with an empty `blocked`, which
-- access_public_blocked reads as "not blocked" and accessPublic.ts as "not named".
create or replace function public.access_for_public(p_client_id text)
returns jsonb
language sql
stable
security definer
set search_path to ''
as $function$
  select case
           when e.block or e.report then (
             select jsonb_build_object(
                      'mode',    case when e.block then 'block' else 'report' end,
                      'holds',   h.holds,
                      'blocked', coalesce((select jsonb_object_agg(d.module, d.state = 'off' or (h.holds and d.state <> 'on'))
                                             from public.access_resolve_detail(p_client_id) d), '{}'::jsonb))
               from (
                 select coalesce(
                          -- a. a usable subscription, to a plan that is not a draft
                          exists (select 1
                                    from public.access_usable_plans(p_client_id) f
                                    join public.access_plans p on p.key = f and p.status <> 'draft')
                          -- b. an operator's assignment that has not expired, to a plan that is not a draft
                          or exists (select 1
                                       from public.client_access_plans a
                                       join public.access_plans p on p.key = a.plan_key and p.status <> 'draft'
                                      where a.client_id = p_client_id and (a.expires_at is null or a.expires_at > now()))
                          or exists (select 1
                                       from public.client_settings s
                                      where s.client_id = p_client_id
                                        and (
                                          -- c. a dated free period still running, and a plan it confers
                                          (s.billing_exempt_until is not null and s.billing_exempt_until > now()
                                            and exists (select 1 from public.access_plans p where p.free_period and p.status <> 'draft'))
                                          -- d. ours or Non-billable, and an active public plan that includes a tab
                                          or ((coalesce(s.internal_account, false) or coalesce(s.billing_exempt, false))
                                            and exists (select 1
                                                          from public.access_plans p
                                                          join public.access_plan_modules pm on pm.plan_key = p.key and pm.state = 'included'
                                                         where p.status = 'active' and p.visibility = 'public'))
                                          -- e. the phone-only shape
                                          or coalesce(s.phone_only, false))),
                          false) as holds
                 -- Keep this `offset 0`. `holds` is read twice above (the key, and each tab's answer)
                 -- and without it the planner copies this whole rule into both places and runs it twice.
                 offset 0
               ) h)
           else null
         end
    from (
      select (p_client_id is not null and (
               coalesce(c.value -> 'server_all' = 'true'::jsonb, false)
               or coalesce(jsonb_typeof(c.value -> 'server_clients') = 'array' and (c.value -> 'server_clients') ? p_client_id, false)
             )) as block,
             (p_client_id is not null
               and coalesce(jsonb_typeof(c.value -> 'server_report') = 'array' and (c.value -> 'server_report') ? p_client_id, false)
             ) as report
        from (select 1) one
        left join public.access_config c on c.key = 'enforce'
    ) e
$function$;

comment on function public.access_for_public(text) is
  'For the public pages: null = the old rules; else { mode: block | report, holds, blocked: { tab: bool } } '
  'for a company named for the server (388''s lists). A tab is blocked when it is off, or when the '
  'company holds a plan and the tab is not on. Holds = 386''s held rule, read from what the company '
  'holds and not from its tabs'' reasons; change the two together. Migration 389.';

revoke execute on function public.access_for_public(text) from public, anon, authenticated;
grant  execute on function public.access_for_public(text) to service_role;

-- ── 2. The yes/no the public database functions ask ───────────────────────────────────────────
-- It sits inside a customer's page load, so it must not be able to fail: the whole body is under
-- one handler that answers false. (A cancelled statement is not an error it can catch, and should
-- not be.) Null and unknown input answer false without asking anything.
create or replace function public.access_public_blocked(p_client_id text, p_module text)
returns boolean
language plpgsql
stable
security definer
set search_path to ''
as $function$
declare
  v jsonb;
begin
  if p_client_id is null or p_module is null then
    return false;
  end if;
  v := public.access_for_public(p_client_id);
  return coalesce(v ->> 'mode' = 'block' and (v -> 'blocked' -> p_module) = 'true'::jsonb, false);
exception when others then
  return false;
end
$function$;

comment on function public.access_public_blocked(text, text) is
  'True only when access_for_public says mode block and this tab is blocked. Cannot raise; every '
  'doubt is false. Called inside get_public_shop, as its owner. Migration 389.';

revoke execute on function public.access_public_blocked(text, text) from public, anon, authenticated;
grant  execute on function public.access_public_blocked(text, text) to service_role;

-- ── 3. get_public_shop: a blocked shop reads as a shop that is off ────────────────────────────
do $m389$
declare
  v_fn     regprocedure := to_regprocedure('public.get_public_shop(text)');
  v_src    text;
  v_new    text;
  v_anchor text := 'if not found or not v_shop.enabled then';
  v_line   text := $l$if not found or not v_shop.enabled or public.access_public_blocked(p_client_id, 'inventory') then$l$;
  v_name   text := 'access_public_blocked';
  v_hits   integer;
  v_owner  text;
  v_before jsonb;
  v_n      integer;
  v_dark   integer;
  v_moved  text;
  v_who    text;
begin
  if v_fn is null then
    raise exception '389: public.get_public_shop(text) is not there (310 and 314 first); nothing changed';
  end if;
  perform set_config('lock_timeout', '5s', true);
  v_src := pg_get_functiondef(v_fn);

  -- The helper is closed to the browser roles, so get_public_shop must reach it as its owner.
  select p.proowner::regrole::text into v_owner from pg_catalog.pg_proc p where p.oid = v_fn;
  if not has_function_privilege(v_owner, 'public.access_public_blocked(text, text)', 'execute') then
    raise exception '389: get_public_shop runs as %, who cannot execute access_public_blocked', v_owner;
  end if;

  if position(v_name in v_src) > 0 then
    raise notice '389: get_public_shop already asks access_public_blocked; nothing to splice';
  else
    v_hits := (length(v_src) - length(replace(v_src, v_anchor, ''))) / length(v_anchor);
    if v_hits <> 1 then
      raise exception '389: the line "%" is in the live get_public_shop % time(s), expected exactly 1. The function has changed shape: dump it again (pg_get_functiondef) and re-derive the splice. Nothing changed.', v_anchor, v_hits;
    end if;
    -- Every shop's answer as it is now, for check 5.
    select coalesce(jsonb_object_agg(s.client_id, public.get_public_shop(s.client_id)), '{}'::jsonb) into v_before
      from public.shop_settings s;
    v_new := replace(v_src, v_anchor, v_line);
    if length(v_new) <> length(v_src) + length(v_line) - length(v_anchor) then
      raise exception '389: the spliced body is % chars, expected %; refusing to execute', length(v_new), length(v_src) + length(v_line) - length(v_anchor);
    end if;
    execute v_new;
    raise notice '389: get_public_shop now asks access_public_blocked (% -> % chars, was md5 %)', length(v_src), length(v_new), md5(v_src);
  end if;

  -- Checks, on a first apply and on a re-run alike.
  v_src := pg_get_functiondef(v_fn);
  if (length(v_src) - length(replace(v_src, v_name, ''))) / length(v_name) <> 1 then
    raise exception '389: get_public_shop does not name access_public_blocked exactly once';
  end if;
  if (length(v_src) - length(replace(v_src, v_line, ''))) / length(v_line) <> 1 or position(v_anchor in v_src) > 0 then
    raise exception '389: get_public_shop does not hold the spliced line exactly once, or still holds the old one';
  end if;
  if not exists (select 1 from pg_catalog.pg_proc p where p.oid = v_fn and p.prosecdef and p.provolatile = 's'
                    and p.proconfig @> array['search_path=""']) then
    raise exception '389: get_public_shop lost STABLE, SECURITY DEFINER or its empty search_path';
  end if;
  if not has_function_privilege('anon', 'public.get_public_shop(text)', 'execute') then
    raise exception '389: anon lost EXECUTE on get_public_shop; every shop page would fail to load';
  end if;

  -- 5 and 6. Nothing moved but what this blocks, and this blocks nothing it was not told it may.
  -- Skipped on a re-run (there is no "before" to compare).
  if v_before is not null then
    select count(*) filter (where not k.blocked and n.g is distinct from b.f),
           count(*) filter (where k.blocked and n.g is distinct from jsonb_build_object('ok', false, 'reason', 'not_found')),
           count(*) filter (where k.blocked and (b.f ->> 'ok') = 'true'),
           string_agg(b.client_id, ', ' order by b.client_id) filter (where not k.blocked and n.g is distinct from b.f),
           string_agg(b.client_id, ', ' order by b.client_id) filter (where k.blocked and (b.f ->> 'ok') = 'true')
      into v_n, v_hits, v_dark, v_moved, v_who
      from jsonb_each(v_before) b(client_id, f)
      cross join lateral (select public.get_public_shop(b.client_id) as g) n
      cross join lateral (select public.access_public_blocked(b.client_id, 'inventory') as blocked) k;
    -- "Before" and "after" are two statements, so two snapshots on the live database: a builder's
    -- edit or a sale that commits between them lands here too. The message must not blame the
    -- splice alone for that.
    if v_n > 0 then
      raise exception '389: get_public_shop changed for % shop(s) this does not block (%). Either the splice moved something it must not, or one of those shops was edited, or a unit in it sold, while this was applying (the two looks are separate statements). Nothing changed. Apply again: it is safe, and if it stops here a second time with nobody working in those shops, the splice is wrong.', v_n, v_moved;
    end if;
    if v_hits > 0 then
      raise exception '389: % blocked shop(s) do not answer not_found', v_hits;
    end if;
    -- 6. This apply closes no shop unless it was told it may, with the exact count.
    if v_dark > 0 and btrim(coalesce(current_setting('ss.m389_shops_may_close', true), '')) is distinct from v_dark::text then
      raise exception '389: applying this would close % open shop(s) at once (%). They are already named in block mode (server_clients or server_all) and their plan or shape blocks the lot shop, so it would go dark the moment this commits, with no report phase. Nothing changed. Either take them out of the list, apply, and name them again when their shop should close; or accept it by running  select set_config(''ss.m389_shops_may_close'', ''%'', true);  first, in the same call as this file.', v_dark, v_who, v_dark;
    end if;
    raise notice '389: % shop(s) that were open are blocked by their plan as of this apply (%)', v_dark, coalesce(v_who, 'none');
  end if;
end
$m389$;

-- ── 4. Rehearsal: the shape this migration promises, or it does not apply ─────────────────────
do $$
begin
  if has_function_privilege('anon', 'public.access_for_public(text)', 'execute')
     or has_function_privilege('authenticated', 'public.access_for_public(text)', 'execute')
     or has_function_privilege('anon', 'public.access_public_blocked(text, text)', 'execute')
     or has_function_privilege('authenticated', 'public.access_public_blocked(text, text)', 'execute') then
    raise exception '389: a browser role can execute a public-access function';
  end if;
  if not has_function_privilege('service_role', 'public.access_for_public(text)', 'execute') then
    raise exception '389: service_role cannot execute access_for_public; the edge functions could not read it';
  end if;
  if public.access_for_public(null) is not null then
    raise exception '389: a null company reads as named';
  end if;
  if public.access_public_blocked(null, null) is distinct from false then
    raise exception '389: access_public_blocked(null, null) is not false';
  end if;
  -- Naming a company for the PORTAL must not name it here.
  if exists (
    select 1
      from public.access_config c,
           jsonb_array_elements_text(case when jsonb_typeof(c.value -> 'clients') = 'array' then c.value -> 'clients' else '[]'::jsonb end) k
     where c.key = 'enforce'
       and not coalesce(c.value -> 'server_all' = 'true'::jsonb, false)
       and not coalesce(jsonb_typeof(c.value -> 'server_clients') = 'array' and (c.value -> 'server_clients') ? k, false)
       and not coalesce(jsonb_typeof(c.value -> 'server_report') = 'array' and (c.value -> 'server_report') ? k, false)
       and (public.access_for_public(k) is not null or public.access_public_blocked(k, 'inventory'))
  ) then
    raise exception '389: a company named only for the portal reads as named for the public pages';
  end if;
end $$;
