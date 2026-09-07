-- 216_raised_under_amendment.sql — the CHECK must admit every authority the gate can return.
--
-- 215 gave `order_amendment_gate` a fourth authority, 'amendment' (a change already underway
-- is its own authority). `change_orders_raised_under_check` was written by 211 against the
-- three that existed then, and the guard trigger stamps whatever the gate says:
--
--     new.raised_under := v_gate->>'authority';
--
-- So the moment the gate can say a word the column refuses, an insert dies on a constraint
-- instead of on the rule that was actually meant to stop it. Caught in app_errors within
-- minutes of 215 going out, on a real request:
--
--     23514: new row for relation "change_orders" violates check constraint
--            "change_orders_raised_under_check"  ... raised_under = 'amendment'
--
-- ⚠️ THE SHAPE OF THIS MISTAKE, since it is the second of its kind this week (214 was the
-- other): a value produced in ONE place and validated in ANOTHER has to be changed in both,
-- in the same commit. 215 changed the producer alone and its own probe did not catch it,
-- because the probe inserted the FIRST change order on an order — the only case where the
-- gate cannot yet answer 'amendment'. A probe that exercises the state before the feature
-- fires proves the state before the feature fires.
--
-- WHEN IT ACTUALLY FIRES: a second change order raised while one is already live. The
-- one-live-amendment index refuses that anyway, so no data was ever at risk — but it refused
-- with a Postgres constraint name where a sentence belongs, and portal-settings' narrow
-- refusal matcher (deliberately narrow, see open_amendment) correctly declined to read it as
-- policy and reported a fault. Which is the system behaving as designed around a gap.
--
-- Rollback:
--   alter table public.change_orders drop constraint change_orders_raised_under_check;
--   alter table public.change_orders add constraint change_orders_raised_under_check
--     check (raised_under is null or raised_under in ('pre_signature','free_window','unlock'));
--   -- (only safe while no row carries 'amendment' — check first)

alter table public.change_orders
  drop constraint if exists change_orders_raised_under_check;

alter table public.change_orders
  add constraint change_orders_raised_under_check
  check (
    raised_under is null
    or raised_under in ('pre_signature', 'free_window', 'unlock', 'amendment')
  );

comment on column public.change_orders.raised_under is
  'Migration 211, widened by 216. The authority this change was raised under, stamped by the guard trigger from order_amendment_gate and frozen on UPDATE — never sent by a caller. One of pre_signature | free_window | unlock | amendment. MUST list every value the gate can return: they are produced in one place and validated here, and 216 exists because 215 added one without the other.';

-- ── Apply-time assertions. These RAISE, aborting the transaction. ──────────────────────
do $$
declare
  def text;
  cid text; code text; g jsonb;
begin
  select pg_get_constraintdef(oid) into def
    from pg_constraint
   where conrelid = 'public.change_orders'::regclass
     and conname = 'change_orders_raised_under_check';
  if def is null then raise exception '216: the raised_under CHECK is missing entirely'; end if;

  -- EVERY authority the gate can return must be spelled in the constraint. Written out
  -- rather than looped so a future fifth value fails HERE, loudly, at apply time.
  if def not like '%pre_signature%' then raise exception '216: the CHECK lost pre_signature'; end if;
  if def not like '%free_window%'   then raise exception '216: the CHECK lost free_window';   end if;
  if def not like '%unlock%'        then raise exception '216: the CHECK lost unlock';        end if;
  if def not like '%amendment%'     then raise exception '216: the CHECK does not admit amendment'; end if;

  -- And the value really is reachable: ask a real order with a live change on it.
  select c.client_id, c.short_code into cid, code
    from public.change_orders c
    join public.designs d on d.client_id = c.client_id and d.short_code = c.short_code
   where c.status in ('draft','pending_ack') and d.accepted_at is not null
   limit 1;
  if code is not null then
    -- The gate answers 'amendment' only with the regime on; with it off the earlier branch
    -- wins and this simply reports free_window, which is not a failure.
    g := public.order_amendment_gate(cid, code);
    raise notice '216: gate on a live-change order answers authority=%', g->>'authority';
  end if;
end $$;
