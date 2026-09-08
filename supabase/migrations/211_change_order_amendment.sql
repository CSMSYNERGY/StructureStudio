-- 211_change_order_amendment.sql — a change order becomes a state machine over the whole
-- order: draft while the rep is editing, then out to the customer, then agreed.
--
-- WHY `draft`. Carolyn: "when we click the change order button, that should open the
-- invoice/design/entire order and allow the sales rep to edit/add/remove/change anything".
-- That is not one keystroke — a rep may spend an hour in the designer over several rounds.
-- Today the FIRST resubmit of an accepted design mints a `pending_ack` change order
-- (submit-estimate:2399) and customer-quotes puts it straight in front of the customer, so
-- they would watch a half-finished change land in their portal a piece at a time and be asked
-- to approve it. `draft` is the rep's workspace: invisible to the customer, and the thing the
-- unlock is spent on.
--
-- `draft` DELIBERATELY DOES NOT BLOCK INVOICING. send_invoice's 409 stays keyed on
-- `pending_ack` alone. An abandoned draft that bricked invoicing forever is the orphan-CO
-- hazard 126 and submit-estimate:2426-2442 both already guard against, and it would be a
-- worse bug than the one this fixes.
--
-- NO `revision` COLUMN. An earlier draft carried one for the re-signing work. `co_no` is
-- already a server-assigned, advisory-locked, per-design sequence that nothing may change
-- (126:107-131) — a second counter beside it is a second thing to keep in step, and the day
-- they disagree the customer signs the wrong document. The invoice revision IS `co_no`.
--
-- ── THE FEE, AND WHERE IT LIVES ───────────────────────────────────────────────────────
-- On THIS ROW, stamped once at insert and frozen. Not in `estimate_lines`: submit-estimate
-- rebuilds that array wholesale from the catalog on every resubmit, so a fee line inside it is
-- destroyed by the next round of editing and the money silently vanishes — and the whole point
-- of an amendment is that the rep edits repeatedly. And NOT folded into `total_after_cents`
-- either: alreadyInSnapshot (_shared/estimateLines.ts) identifies a design-edit change order
-- by matching that figure against a snapshot total, so burying a fee in it makes the design
-- edit fail to match and get billed a second time as its own line — the two-wrong-rows bug
-- that file's header documents. The fee rides beside the total and becomes a line at render.
--
-- FROZEN ON UPDATE, WHICH IS THE TRAP. Both design_edit writers UPSERT one pending change
-- order and rewrite it on every resubmit. If the fee were re-stamped there, a rep who saved
-- five times would owe five fees. Same for the unlock and the authority.
--
-- ⚠️ THE INSERT REFUSAL APPLIES TO THE SERVICE ROLE TOO. "Is this order open for change" is a
-- business rule, not a permission, and submit-estimate's post-acceptance resubmit — a service
-- role write — is precisely the act it governs. Consequence to know about: submit-estimate
-- persists the revision to `designs` BEFORE it inserts the change order, so a refusal here
-- would leave the design revised with no change order recorded. That cannot happen today
-- (209 leaves co_unlock_required false everywhere, so the gate answers open for every order in
-- the database), and Phase 2 puts the same gate at the top of that handler, before it writes.
-- Do not turn the regime on for a tenant until that has shipped.
--
-- Rollback: re-create change_orders_guard() from 126, restore the status CHECK to its three
-- values (no row may be in 'draft'), drop the five columns, drop change_orders_one_live.

-- ── PART 0 — blast radius ──────────────────────────────────────────────────────────────
--   select status, count(*) from public.change_orders group by status;
--   -- 2026-09-07: acknowledged 7, pending_ack 2, void 1. No design holds two live rows,
--   -- so the one-live-amendment index below is satisfied by the data as it stands.

-- ── PART 1 — statuses and columns ──────────────────────────────────────────────────────
do $$
begin
  -- Guard the ALTER: a failed ADD CONSTRAINT on live data is the one way this file could
  -- brick the table half-applied, so prove the data fits before touching the constraint.
  if exists (select 1 from public.change_orders
              where status not in ('draft','pending_ack','acknowledged','void')) then
    raise exception '211: a change order holds a status outside the new vocabulary';
  end if;
end $$;

alter table public.change_orders drop constraint if exists change_orders_status_check;
alter table public.change_orders add constraint change_orders_status_check
  check (status in ('draft','pending_ack','acknowledged','void'));

alter table public.change_orders
  add column if not exists unlock_id     uuid references public.order_unlocks(id),
  -- Which authority this change was raised under. Evidence, and the reason a fee is or is not
  -- on the order. NULL on every row that predates this migration.
  add column if not exists raised_under  text,
  add column if not exists fee_cents     integer,
  add column if not exists fee_tax_cents integer,
  add column if not exists fee_taxable   boolean;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'change_orders_raised_under_check') then
    alter table public.change_orders add constraint change_orders_raised_under_check
      check (raised_under is null or raised_under in ('pre_signature','free_window','unlock'));
  end if;
  -- An unlock-authorised change must name the unlock it spent, or closer #2 in 210 is a lie.
  if not exists (select 1 from pg_constraint where conname = 'change_orders_authority_shape') then
    alter table public.change_orders add constraint change_orders_authority_shape
      check (raised_under is distinct from 'unlock' or unlock_id is not null);
  end if;
  if not exists (select 1 from pg_constraint where conname = 'change_orders_fee_nonneg') then
    alter table public.change_orders add constraint change_orders_fee_nonneg
      check ((fee_cents is null or fee_cents >= 0) and (fee_tax_cents is null or fee_tax_cents >= 0));
  end if;
  -- Tax on a fee only exists when there IS a taxable fee. Stops a stray tax figure riding on
  -- a zero fee and printing on a customer's document.
  if not exists (select 1 from pg_constraint where conname = 'change_orders_fee_tax_shape') then
    alter table public.change_orders add constraint change_orders_fee_tax_shape
      check (coalesce(fee_tax_cents, 0) = 0
             or (fee_taxable is true and coalesce(fee_cents, 0) > 0));
  end if;
end $$;

-- ONE LIVE AMENDMENT PER DESIGN. Two half-finished changes on one order is two people editing
-- the same building with no way to say which the customer agreed to.
create unique index if not exists change_orders_one_live
  on public.change_orders (client_id, short_code)
  where status in ('draft','pending_ack');

comment on column public.change_orders.fee_cents is
  'Migration 211. The change-order fee, stamped from client_settings at INSERT and frozen on UPDATE — the design_edit writers upsert this row on every resubmit, and a re-stamped fee would charge a rep per keystroke. Rendered as its own line by amendedInvoiceDocument; deliberately NOT folded into total_after_cents, which alreadyInSnapshot matches against a snapshot total.';

-- ── PART 2 — the guard, re-issued. Every rule 126 had, plus the amendment ones. ────────
create or replace function public.change_orders_guard()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $fn$
declare
  -- Browser writes always resolve a real user; the service role (customer-accept,
  -- submit-estimate) and direct SQL do not. anon has no grant on this table at all.
  v_trusted boolean := auth.uid() is null;
  v_gate jsonb;
  v_rate numeric;
begin
  if tg_op = 'INSERT' then
    -- Server-assigned per-design sequence (orders_assign_no pattern): the advisory lock
    -- serialises concurrent inserts for one design; the number is never caller-supplied.
    perform pg_advisory_xact_lock(hashtext('ss_co_no:' || new.client_id || ':' || new.short_code));
    select coalesce(max(co_no), 0) + 1 into new.co_no
      from public.change_orders
     where client_id = new.client_id and short_code = new.short_code;
    new.created_by := coalesce(auth.uid(), new.created_by);
    new.updated_at := now();

    -- ── THE AMENDMENT GATE (211) ──────────────────────────────────────────────────────
    -- Asked of every writer including the service role: whether a signed order may be
    -- changed at all is the builder's rule, not the caller's.
    v_gate := public.order_amendment_gate(new.client_id, new.short_code);
    if not coalesce((v_gate->>'open')::boolean, true) then
      raise exception '%', coalesce(v_gate->>'reason',
        'this order is signed — an admin or crew leader has to unlock it before it can be changed');
    end if;

    -- STAMPED, NEVER READ FROM THE CALLER. A browser that could set these could grant itself
    -- an unlock and waive its own fee.
    new.raised_under := v_gate->>'authority';
    new.unlock_id    := nullif(v_gate->>'unlock_id', '')::uuid;
    new.fee_cents    := coalesce((v_gate->>'fee_cents')::int, 0);
    new.fee_taxable  := coalesce((v_gate->>'fee_taxable')::boolean, false);

    -- The fee's tax, at the rate THE AGREEMENT CARRIES — never a re-resolved one. Acceptance
    -- was a click on a stated total; billing a different rate because the jurisdiction moved
    -- in between is a change order of its own, not a re-render. Cent-scaled the way
    -- salesTax.ts::taxOn scales it, and bounded by the same 25% sanity ceiling.
    if new.fee_taxable and coalesce(new.fee_cents, 0) > 0 then
      select nullif(coalesce(d.accepted_snapshot->'estimateLines'->'tax'->>'rate',
                             d.estimate_lines->'tax'->>'rate'), '')::numeric
        into v_rate
        from public.designs d
       where d.client_id = new.client_id and d.short_code = new.short_code;
      if v_rate is not null and v_rate > 0 and v_rate <= 0.25 then
        new.fee_tax_cents := round(new.fee_cents * v_rate);
      else
        new.fee_tax_cents := 0;
      end if;
    else
      new.fee_tax_cents := 0;
    end if;

    -- Spend the unlock in the same statement that used it, so two concurrent inserts cannot
    -- both claim one grant.
    if new.unlock_id is not null then
      update public.order_unlocks
         set consumed_at = now(), consumed_by_change_order = new.id
       where id = new.unlock_id and consumed_at is null and released_at is null;
    end if;

    if new.status = 'acknowledged' then
      if new.ack_method = 'signature' and not v_trusted then
        raise exception 'a signature acknowledgment can only be recorded by the signing flow';
      end if;
      if new.ack_method = 'verbal' then
        -- Creating it already-verbal IS the attestation: stamp who and when.
        new.verbal_recorded_by := coalesce(auth.uid(), new.verbal_recorded_by);
        new.acknowledged_at := coalesce(new.acknowledged_at, now());
      end if;
    end if;
    return new;
  end if;

  -- UPDATE
  new.updated_at := now();
  new.co_no := old.co_no;                    -- the number never changes
  new.created_by := old.created_by;
  new.created_at := old.created_at;

  -- THE FEE TRAP. Both design_edit writers rewrite this row on every resubmit; without these
  -- six lines a rep who saved five times would owe five fees, under five different
  -- authorities, having spent one unlock.
  new.unlock_id     := old.unlock_id;
  new.raised_under  := old.raised_under;
  new.fee_cents     := old.fee_cents;
  new.fee_tax_cents := old.fee_tax_cents;
  new.fee_taxable   := old.fee_taxable;

  if new.ack_method = 'signature' and old.ack_method is distinct from 'signature' and not v_trusted then
    raise exception 'a signature acknowledgment can only be recorded by the signing flow';
  end if;

  -- A draft is the rep's workspace. It leaves only towards the customer, or into the bin.
  if old.status = 'draft' and new.status not in ('draft', 'pending_ack', 'void') then
    raise exception 'a draft change order can only be sent for approval or discarded';
  end if;
  -- And nothing may go BACK to draft: once the customer has been asked, the text they were
  -- asked about is the record.
  if new.status = 'draft' and old.status is distinct from 'draft' then
    raise exception 'a change order cannot go back to draft — void it and raise a new one';
  end if;

  if old.status = 'acknowledged' then
    -- Frozen: the customer agreed to THIS text and THESE numbers. The only exit is void.
    if new.status = 'pending_ack' then
      raise exception 'an acknowledged change order cannot go back to pending — void it and raise a new one';
    end if;
    if new.description is distinct from old.description
       or new.total_before_cents is distinct from old.total_before_cents
       or new.total_after_cents  is distinct from old.total_after_cents
       or new.version_before is distinct from old.version_before
       or new.version_after  is distinct from old.version_after
       or new.ack_method is distinct from old.ack_method
       or new.acceptance_id is distinct from old.acceptance_id
       or new.verbal_rep_name is distinct from old.verbal_rep_name
       or new.verbal_conversation_date is distinct from old.verbal_conversation_date
       or new.acknowledged_at is distinct from old.acknowledged_at then
      raise exception 'an acknowledged change order is frozen — void it and raise a new one';
    end if;
  end if;

  if new.status = 'void' and old.status <> 'void' then
    if new.void_reason is null or btrim(new.void_reason) = '' then
      raise exception 'voiding a change order needs a reason';
    end if;
    new.voided_at := coalesce(new.voided_at, now());
    -- CLOSER #3 (210): give the unlock back. A rep who mis-staged should not have to ask a
    -- second time for permission they were already granted; the original expiry still stands.
    if old.unlock_id is not null then
      update public.order_unlocks
         set consumed_at = null,
             release_reason = 'change order CO-' || old.co_no || ' was voided'
       where id = old.unlock_id and consumed_by_change_order = old.id and released_at is null;
    end if;
  end if;

  if new.status = 'acknowledged' and old.status = 'pending_ack' and new.ack_method = 'verbal' then
    new.verbal_recorded_by := coalesce(auth.uid(), new.verbal_recorded_by);
    new.acknowledged_at := coalesce(new.acknowledged_at, now());
  end if;

  return new;
end;
$fn$;

revoke execute on function public.change_orders_guard() from public, anon, authenticated;

drop trigger if exists change_orders_guard_trg on public.change_orders;
create trigger change_orders_guard_trg
  before insert or update on public.change_orders
  for each row execute function public.change_orders_guard();

-- ── PART 3 — the browser INSERT policy admits a draft ──────────────────────────────────
-- 126's shape rule, widened by one state. A browser may open a draft, send it for approval,
-- or attest to a conversation. The signature shape stays unreachable (the trigger refuses it),
-- and the policy keeps narrowing it anyway — defence in depth over a table of agreements.
-- The per-person gate is still 188's restrictive policy; this one is tenant + shape only.
drop policy if exists change_orders_owner_insert on public.change_orders;
create policy change_orders_owner_insert on public.change_orders
  for insert to authenticated
  with check (
    client_id = public.current_client_id()
    and (status = 'draft'
         or status = 'pending_ack'
         or (status = 'acknowledged' and ack_method = 'verbal'))
  );

-- ── PART 4 — apply-time assertions. These RAISE, aborting the transaction. ─────────────
do $$
declare n int; def text;
begin
  select pg_get_constraintdef(oid) into def from pg_constraint where conname = 'change_orders_status_check';
  if def is null or def not like '%draft%' then raise exception '211: the status CHECK does not admit draft'; end if;

  select count(*) into n from information_schema.columns
   where table_schema = 'public' and table_name = 'change_orders'
     and column_name in ('unlock_id','raised_under','fee_cents','fee_tax_cents','fee_taxable');
  if n <> 5 then raise exception '211: expected 5 new columns, found %', n; end if;

  if not exists (select 1 from pg_indexes where schemaname='public' and indexname='change_orders_one_live') then
    raise exception '211: the one-live-amendment index is missing';
  end if;

  if not exists (
    select 1 from pg_trigger t join pg_class c on c.oid = t.tgrelid
     where c.relname = 'change_orders' and t.tgname = 'change_orders_guard_trg' and not t.tgisinternal
  ) then raise exception '211: the guard trigger is not installed'; end if;

  if has_function_privilege('authenticated', 'public.change_orders_guard()', 'execute') then
    raise exception '211: authenticated can execute the guard directly';
  end if;

  -- The 188 per-person gate must still be the thing standing between a rep and this table.
  select count(*) into n from pg_policies
   where schemaname='public' and tablename='change_orders'
     and policyname in ('change_orders_area_insert','change_orders_area_update');
  if n <> 2 then raise exception '211: 188 restrictive policies are missing (found %)', n; end if;
end $$;

-- ── PART 5 — BEHAVIOURAL PROBE. Proves the RULE, not the schema. Rolled back. ──────────
-- Nothing else in this repo proves a trigger's behaviour rather than its existence, and this
-- trigger is the whole feature. Runs inside a sub-transaction and leaves nothing behind.
do $$
declare
  cid text; code text; v_id uuid; g jsonb; got record; fired boolean := false;
begin
  select d.client_id, d.short_code into cid, code
    from public.designs d
    join public.orders o on o.client_id = d.client_id and o.short_code = d.short_code
   where d.accepted_at is not null
     and not exists (select 1 from public.change_orders c
                      where c.client_id = d.client_id and c.short_code = d.short_code
                        and c.status in ('draft','pending_ack'))
   limit 1;
  if code is null then
    raise notice '211: no signed order free of a live change order — behavioural probe skipped';
    return;
  end if;

  begin
    -- 1. With the regime dormant, a draft inserts and is stamped free_window with no fee.
    insert into public.change_orders (client_id, short_code, source, status, description)
    values (cid, code, 'manual', 'draft', '211 probe — rolled back')
    returning * into got;

    if got.raised_under <> 'free_window' then
      raise exception '211 probe: expected raised_under free_window, got %', got.raised_under;
    end if;
    if coalesce(got.fee_cents, -1) <> 0 then
      raise exception '211 probe: a fee was stamped while the regime is off (%)', got.fee_cents;
    end if;
    if got.co_no is null or got.co_no < 1 then
      raise exception '211 probe: co_no was not assigned';
    end if;

    -- 2. A second live amendment on the same design is refused by the index.
    begin
      insert into public.change_orders (client_id, short_code, source, status, description)
      values (cid, code, 'manual', 'draft', '211 probe — second live');
      raise exception '211 probe: a SECOND live amendment was allowed';
    exception when unique_violation then
      fired := true;
    end;
    if not fired then raise exception '211 probe: the one-live index did not fire'; end if;

    -- 3. A draft cannot jump straight to acknowledged.
    fired := false;
    begin
      update public.change_orders set status = 'acknowledged', ack_method = 'verbal',
             verbal_rep_name = 'probe', verbal_conversation_date = current_date
       where id = got.id;
      raise exception '211 probe: a draft was acknowledged directly';
    exception when others then
      if sqlstate = 'P0001' and sqlerrm like '%can only be sent for approval or discarded%'
      then fired := true; else raise; end if;
    end;
    if not fired then raise exception '211 probe: the draft transition rule did not fire'; end if;

    raise exception 'ROLLBACK_PROBE';
  exception
    when others then
      if sqlerrm = 'ROLLBACK_PROBE' then
        raise notice '211: behavioural probe passed (stamped authority, one-live index, draft transitions)';
      else
        raise;
      end if;
  end;
end $$;
