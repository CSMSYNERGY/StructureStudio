-- 337 — "Hide pricing" is a CUSTOMER-FACING setting, not a tenant-wide blindfold.
--
-- client_settings.show_pricing exists so a builder can hand a shopper a designer with no money in
-- it. get_config enforced it per TENANT with no idea who was asking: the same stripped payload went
-- to the anonymous shopper and to the builder's own staff in the portal, so a hide-prices tenant's
-- reps built estimates they could not see the price of (Carolyn, 2026-10-26: "Pricing should never
-- be hidden for internal").
--
-- The rule now: prices are withheld from the PUBLIC page only. They are returned in full when the
-- caller is
--   * a user of that tenant (client_users — the portal's own sign-in), or
--   * a Structure Studio operator (is_operator(), which is also what a "viewing as" support
--     session carries).
-- Anonymous and customer logins are neither, so nothing new reaches a shopper's browser.
--
-- HOW: the 18 show_pricing tests inside get_config are byte-identical, so they are replaced in one
-- pass with a call to the new ss_prices_visible(client_id). The body is spliced out of the LIVE
-- function (207/238/313's anchor-replace pattern), never rewritten, so every later key keeps
-- whatever it says today. PART 3 proves it by comparing every tenant's config md5 before and after:
-- this migration runs as the migrator, who is neither staff nor an operator, so the answer it gets
-- must be exactly the answer it got before.
--
-- Rollback (prices tenant-wide again, keeping every other key):
--   begin;
--   do $rb$
--   declare src text;
--   begin
--     src := pg_get_functiondef('public.get_config(text)'::regprocedure);
--     src := replace(src, $k$public.ss_prices_visible(cc.client_id)$k$,
--                    $k$coalesce((select cs.show_pricing from public.client_settings cs where cs.client_id = cc.client_id), false)$k$);
--     execute src;
--   end $rb$;
--   drop function if exists public.ss_prices_visible(text);
--   delete from supabase_migrations.schema_migrations where version = '337';
--   notify pgrst, 'reload schema';
--   commit;

begin;

-- Every tenant's config as the migrator sees it now (no JWT → not staff, not an operator), for
-- PART 3 to compare against. Dropped at commit.
create temp table m337_before on commit drop as
  select cc.client_id, md5(public.get_config(cc.client_id)::text) as cfg
  from public.client_configs cc;

-- ── PART 1 · who may see money ────────────────────────────────────────────────────────────────
-- SECURITY DEFINER for the same reason get_config is: it reads client_settings and client_users,
-- which anon cannot select. STABLE, so it is evaluated once per row like the subselect it replaces.
-- auth.uid() is the CALLER's, not the definer's — a security-definer function does not change who
-- the request is signed as, only what it may read.
create or replace function public.ss_prices_visible(p_client_id text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce((select cs.show_pricing from public.client_settings cs
                   where cs.client_id = p_client_id), false)
      -- The builder's own staff, in the portal. Their sign-in IS the proof of internal.
      or exists (select 1 from public.client_users cu
                 where cu.user_id = auth.uid() and cu.client_id = p_client_id)
      -- Structure Studio support, including a "Seeing this account as …" session.
      or public.is_operator();
$$;

comment on function public.ss_prices_visible(text) is
  'True when the CALLER may be shown this tenant''s prices: the tenant shows pricing publicly, or the caller is one of its portal users, or an operator. get_config''s money gate (337).';

revoke all on function public.ss_prices_visible(text) from public;
grant execute on function public.ss_prices_visible(text) to anon, authenticated, service_role;

-- ── PART 2 · splice get_config ────────────────────────────────────────────────────────────────
do $m337$
declare
  src     text := pg_get_functiondef('public.get_config(text)'::regprocedure);
  old_blk text := $anchor$coalesce((select cs.show_pricing from public.client_settings cs where cs.client_id = cc.client_id), false)$anchor$;
  hits    int;
begin
  if position('ss_prices_visible' in src) > 0 then
    raise notice '337: get_config already asks ss_prices_visible';
    return;
  end if;
  hits := (length(src) - length(replace(src, old_blk, ''))) / length(old_blk);
  -- 18 as of 2026-10-26 (fixtures, cladding, wall heights, insulation, electrical, interior walls,
  -- colors, showPricing itself, layoutPricing, sizePricing). More is fine — a later migration may
  -- have added its own gate in the same words — but NONE means the expression has been reworded,
  -- and a silent no-op here would leave every tenant's staff blind with the migration marked done.
  if hits = 0 then
    raise exception '337: the show_pricing test was not found in the LIVE get_config body — re-derive the anchor from a fresh pg_get_functiondef dump before applying';
  end if;
  raise notice '337: rewriting % show_pricing test(s) in get_config', hits;
  execute replace(src, old_blk, $repl$public.ss_prices_visible(cc.client_id)$repl$);
end $m337$;

-- ── PART 3 · the public answer is unchanged ───────────────────────────────────────────────────
-- The migrator has no JWT, so ss_prices_visible can only have answered show_pricing — byte-for-byte
-- the old behaviour, for every tenant, hidden-pricing ones included.
do $check$
declare bad text;
begin
  select string_agg(b.client_id, ', ')
    into bad
    from m337_before b
    where md5(public.get_config(b.client_id)::text) is distinct from b.cfg;
  if bad is not null then
    raise exception '337: the PUBLIC config changed for: % — the splice altered more than the money gate', bad;
  end if;
end $check$;

notify pgrst, 'reload schema';

commit;
