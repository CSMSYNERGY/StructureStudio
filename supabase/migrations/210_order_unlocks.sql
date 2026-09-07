-- 210_order_unlocks.sql — permission to change ONE signed order, once, and the gate that
-- decides whether an order is open for change at all.
--
-- WHY A TABLE AND NOT A COLUMN ON `orders`. Four reasons, and each is on its own sufficient:
--   * It is EVIDENCE. Who unlocked this order, when, why, and which change they authorised is
--     the answer to a dispute months later. A column is overwritten by the next unlock and
--     answers nothing. design_acceptances (124) is this repo's precedent for exactly that.
--   * An order is unlocked MANY times over its life. Carolyn: a change order can happen "any
--     time throughout the process up until after delivery and final payment". A column holds
--     one.
--   * 199_orders_update_column_grant.sql already narrowed the browser's UPDATE on `orders` to
--     {total_cents, total_source, updated_at}. A column there would be unwritable from a
--     browser anyway, so it buys nothing it does not also cost.
--   * A partial unique index gives "at most one open unlock per order" as an INSERT-time
--     claim rather than a read-then-write race — the design_acceptances_*_once idiom.
--
-- HOW AN ORDER IS NEVER LEFT PERMANENTLY OPEN. Three independent closers, because an unlock
-- that never closes is just the lock removed:
--   1. EXPIRY — `expires_at`, from client_settings.co_unlock_hours (default 72). The gate
--      ignores an expired row. It is deliberately still "open" to the index, because an
--      unlock granted and never used is a fact worth keeping; the next request releases it
--      with release_reason 'expired' rather than pretending it never happened.
--   2. CONSUMPTION — the change order it authorises stamps consumed_at + the CO id (211's
--      trigger, in the same statement that inserts the CO). One unlock, one amendment,
--      however many rounds of editing that amendment absorbs.
--   3. RELEASE — voiding that change order puts the unlock back, keeping the original
--      expires_at, so a rep who mis-stages does not have to go and ask a second time.
--
-- WRITES ARE SERVICE-ROLE ONLY — no INSERT/UPDATE/DELETE policy exists at all. This is
-- 124's posture and 178's argument for why rep-attested acceptance is safe without a trigger:
-- if the browser cannot write the row, nothing in the browser can forge who approved. SELECT
-- is tenant-scoped so the order screen can render the trail.
--
-- Rollback:
--   drop function if exists public.order_amendment_gate(text, text);
--   drop table if exists public.order_unlocks;

-- ── PART 0 — blast radius ──────────────────────────────────────────────────────────────
--   select count(*) from public.change_orders;                 -- 2026-09-07: 10
--   select count(*) from public.designs where accepted_at is not null;  -- 8
-- Nothing reads this table until 211's trigger and the portal-settings actions land, and
-- co_unlock_required is false on every tenant (209), so the gate answers `open` for every
-- order in the database on the day this applies.

-- ── PART 1 — the table ─────────────────────────────────────────────────────────────────
create table if not exists public.order_unlocks (
  id           uuid primary key default gen_random_uuid(),
  client_id    text not null,
  short_code   text not null,
  order_id     uuid,

  -- THE ASK. Null when an approver unlocked the order without being asked, which is a real
  -- case: the builder decides the change is happening before the rep has typed anything.
  requested_by      uuid,
  requested_by_name text,
  requested_at      timestamptz,
  reason            text,

  -- THE DECISION. Null while a request is waiting on someone.
  decision        text check (decision is null or decision in ('granted','declined')),
  decided_by      uuid,
  -- Denormalised deliberately: this is evidence and has to still read correctly years later,
  -- after the person has been renamed, removed, or has left. Same reasoning as 178's
  -- recorded_by_name and 126's verbal_rep_name.
  decided_by_name text,
  decided_at      timestamptz,
  decision_note   text,

  -- A grant is permission for one change, not a standing bypass.
  expires_at timestamptz,

  consumed_at              timestamptz,
  consumed_by_change_order uuid references public.change_orders(id),

  released_at    timestamptz,
  release_reason text,

  created_at timestamptz not null default now(),

  constraint order_unlocks_order_client_fk
    foreign key (order_id, client_id) references public.orders (id, client_id),

  -- A granted row must say when it expires, or closer #1 does not exist for it.
  constraint order_unlocks_grant_shape check (
    decision is distinct from 'granted' or (expires_at is not null and decided_at is not null)
  ),
  -- Nothing can be consumed that was never granted.
  constraint order_unlocks_consumed_shape check (
    consumed_at is null or decision = 'granted'
  )
);

-- AT MOST ONE OPEN UNLOCK PER ORDER — the concurrency claim. "Open" is a waiting request or a
-- granted-but-unspent one. Expiry is NOT in the predicate: `now()` is not immutable and cannot
-- appear in an index. That is why the release path carries the burden — a fresh request
-- releases an expired open row before inserting its own.
create unique index if not exists order_unlocks_one_open
  on public.order_unlocks (client_id, short_code)
  where decision is distinct from 'declined' and consumed_at is null and released_at is null;

create index if not exists order_unlocks_lookup
  on public.order_unlocks (client_id, short_code, created_at desc);

alter table public.order_unlocks enable row level security;
revoke all on public.order_unlocks from anon;
grant select on public.order_unlocks to authenticated;
revoke insert, update, delete, truncate on public.order_unlocks from authenticated;

drop policy if exists order_unlocks_tenant_select on public.order_unlocks;
create policy order_unlocks_tenant_select on public.order_unlocks
  for select to authenticated using (client_id = public.current_client_id());

comment on table public.order_unlocks is
  'Migration 210. Permission to change ONE signed order, once. Service-role writes only — a browser that could write this could forge who approved a change. Read by order_amendment_gate() and rendered on the order''s amendment trail.';

-- ── PART 2 — the gate. ONE function, asked by three doors. ─────────────────────────────
--
-- The unlock re-opens the WHOLE order, so the designer save (save_design), the order document
-- (stage_order_attribute_change) and the change-order insert must all ask the same question.
-- Three copies of this rule would drift, and the one that drifted would be the one that let a
-- rep change a locked order. Same doctrine as estimateLines.ts and changeOrderDiff.ts.
--
-- IT NEVER RAISES. It is called from a trigger and from RLS-adjacent paths, where an exception
-- is a 500 on a save the customer is watching. Every unknown answers "open" — see below.
--
-- FAILS OPEN, ON PURPOSE. A missing settings row, a missing order row, an unreadable design:
-- all answer open=true. The thing on the other side of this gate is a builder editing their
-- own customer's order — the cost of wrongly allowing it is a change order that needed an
-- unlock and did not get one; the cost of wrongly refusing it is a builder locked out of their
-- own business by a NULL. 154's current_area_level takes the same posture for the same reason.
create or replace function public.order_amendment_gate(p_client_id text, p_short_code text)
returns jsonb
language plpgsql
stable
security definer
set search_path to ''
as $fn$
declare
  v_accepted_at timestamptz;
  v_ordered_at  timestamptz;
  v_required    boolean;
  v_free_days   int;
  v_fee_cents   int;
  v_fee_taxable boolean;
  v_unlock      public.order_unlocks;
  v_free_until  timestamptz;
begin
  select d.accepted_at into v_accepted_at
    from public.designs d
   where d.client_id = p_client_id and d.short_code = p_short_code;

  -- NOT YET COMMITTED: there is nothing to re-open and nothing to sign again. `accepted_at`
  -- is the durable fact 197 chose over `status` for exactly this test.
  if v_accepted_at is null then
    return jsonb_build_object('signed', false, 'open', true, 'authority', 'pre_signature',
                              'unlock_id', null, 'expires_at', null,
                              'fee_cents', 0, 'fee_taxable', false,
                              'reason', 'This order has not been accepted yet.');
  end if;

  select cs.co_unlock_required, cs.co_free_days, cs.co_fee_cents, cs.co_fee_taxable
    into v_required, v_free_days, v_fee_cents, v_fee_taxable
    from public.client_settings cs
   where cs.client_id = p_client_id;

  -- THE REGIME IS OFF (the default, 209). Today's behaviour, unchanged.
  if coalesce(v_required, false) = false then
    return jsonb_build_object('signed', true, 'open', true, 'authority', 'free_window',
                              'unlock_id', null, 'expires_at', null,
                              'fee_cents', 0, 'fee_taxable', false,
                              'reason', 'Changing a signed order does not need an unlock at this builder.');
  end if;

  select o.ordered_at into v_ordered_at
    from public.orders o
   where o.client_id = p_client_id and o.short_code = p_short_code;
  -- An order row written before the ensure-order trigger, or a design-less order: fall back
  -- to the acceptance itself, which is the same day for every order the trigger did write.
  v_free_until := coalesce(v_ordered_at, v_accepted_at) + make_interval(days => coalesce(v_free_days, 0));

  if now() < v_free_until then
    return jsonb_build_object('signed', true, 'open', true, 'authority', 'free_window',
                              'unlock_id', null, 'expires_at', v_free_until,
                              'fee_cents', 0, 'fee_taxable', false,
                              'reason', 'Inside this builder''s free-change window.');
  end if;

  select u.* into v_unlock
    from public.order_unlocks u
   where u.client_id = p_client_id and u.short_code = p_short_code
     and u.decision = 'granted'
     and u.consumed_at is null and u.released_at is null
     and u.expires_at > now()
   order by u.decided_at desc
   limit 1;

  if v_unlock.id is not null then
    return jsonb_build_object('signed', true, 'open', true, 'authority', 'unlock',
                              'unlock_id', v_unlock.id, 'expires_at', v_unlock.expires_at,
                              'fee_cents', coalesce(v_fee_cents, 0),
                              'fee_taxable', coalesce(v_fee_taxable, true),
                              'reason', 'Unlocked.');
  end if;

  return jsonb_build_object('signed', true, 'open', false, 'authority', null,
                            'unlock_id', null, 'expires_at', null,
                            'fee_cents', coalesce(v_fee_cents, 0),
                            'fee_taxable', coalesce(v_fee_taxable, true),
                            'reason', 'This order is signed. An admin or crew leader has to unlock it before it can be changed.');
end;
$fn$;

-- Callable by the service role and by 211's SECURITY DEFINER trigger. The browser asks
-- through portal-settings, never directly — same posture as crm_ensure_contact (130).
revoke execute on function public.order_amendment_gate(text, text) from public, anon, authenticated;

-- ── PART 3 — apply-time assertions. These RAISE, aborting the transaction. ──────────────
do $$
declare g jsonb; n int; code text; cid text;
begin
  if not exists (select 1 from pg_tables where schemaname = 'public' and tablename = 'order_unlocks') then
    raise exception '210: order_unlocks was not created';
  end if;
  if not (select relrowsecurity from pg_class where oid = 'public.order_unlocks'::regclass) then
    raise exception '210: RLS is not enabled on order_unlocks';
  end if;

  -- THE CLAIM THIS TABLE RESTS ON: a browser cannot write it. One SELECT policy, nothing else.
  select count(*) into n from pg_policies
   where schemaname = 'public' and tablename = 'order_unlocks' and cmd <> 'SELECT';
  if n <> 0 then raise exception '210: order_unlocks has % non-SELECT policies — writes must be service-role only', n; end if;

  if has_table_privilege('authenticated', 'public.order_unlocks', 'INSERT') then
    raise exception '210: authenticated still holds INSERT on order_unlocks';
  end if;
  if has_function_privilege('authenticated', 'public.order_amendment_gate(text,text)', 'execute') then
    raise exception '210: authenticated can execute order_amendment_gate directly';
  end if;

  -- BEHAVIOURAL PROBE ON REAL DATA, not a schema check. With 209 dormant every order must
  -- come back open; and an unaccepted design must come back pre_signature.
  select d.client_id, d.short_code into cid, code
    from public.designs d where d.accepted_at is not null limit 1;
  if code is not null then
    g := public.order_amendment_gate(cid, code);
    if (g->>'open')::boolean is not true then
      raise exception '210: a signed order came back LOCKED while co_unlock_required is false everywhere — %', g;
    end if;
    if (g->>'authority') <> 'free_window' then
      raise exception '210: expected authority free_window with the regime off, got %', g->>'authority';
    end if;
  end if;

  select d.client_id, d.short_code into cid, code
    from public.designs d where d.accepted_at is null limit 1;
  if code is not null then
    g := public.order_amendment_gate(cid, code);
    if (g->>'authority') <> 'pre_signature' then
      raise exception '210: an unaccepted design should be pre_signature, got %', g->>'authority';
    end if;
  end if;

  -- An unknown design must answer, not throw.
  g := public.order_amendment_gate('no-such-tenant', 'SS-NOPE');
  if g is null then raise exception '210: the gate returned NULL for an unknown design'; end if;
end $$;
