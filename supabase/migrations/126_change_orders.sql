-- 126_change_orders: a change to an existing order needs the customer's acknowledgment.
--
-- SS-mode only in practice (the creators are the SS resubmit path and the SS order card),
-- and the rule is Carolyn's (2026-08-23): EITHER the customer e-signs the change on their
-- quote page, OR the sales rep attests a verbal confirmation — checkbox, rep name, and the
-- date of the conversation. While one is pending, INVOICING IS BLOCKED (portal-settings'
-- send_invoice 409s); scheduling and delivery are deliberately untouched.
--
-- TWO SOURCES:
--   design_edit  the rep reopened the design and resubmitted after the customer had
--                accepted — submit-estimate generates the delta (old vs new totals from
--                the estimate_lines snapshots, generated description) and upserts ONE
--                pending CO per design, updating it on every further resubmit.
--   manual       the rep filled the form on the order (delivery date, discount, anything
--                that isn't a design change) — description + optional new total.
--
-- MONEY: totals are SNAPSHOTS (commission_entries precedent, 078) — total_before/after in
-- cents. On acknowledgment with a total_after set, orders.total_cents is updated with
-- total_source='manual', which also shields it from sync-design-status' GHL repricer.
-- The commissions interaction (an acknowledged CO that moves the total invalidates
-- already-computed commission_entries; kind='clawback' exists for exactly this) is a
-- known hook, deliberately not built here.
--
-- WRITES COME STRAIGHT FROM THE BROWSER under RLS (the orders/payments precedent, 105) —
-- so the unbypassable rules live in a TRIGGER, not edge-function code:
--   * co_no is server-assigned (advisory lock, orders_assign_no pattern), never trusted;
--   * a browser may create a pending CO, or a verbal-acknowledged one (that IS the
--     attestation act) — but can NEVER mint a signature acknowledgment: ack_method =
--     'signature' is reserved for the service role (customer-accept), because a signature
--     record anyone could fabricate from a console is worthless as evidence;
--   * an acknowledged CO's content is frozen — the only exit is void, with a reason.
--
-- Hand-apply via the SQL editor / MCP and record as version 126 — NEVER `supabase db push`.

create table if not exists public.change_orders (
  id                       uuid primary key default gen_random_uuid(),
  client_id                text not null,
  short_code               text not null,      -- primary linkage (orders.short_code is soft)
  order_id                 uuid,               -- optional hard link when the order row exists
  co_no                    integer not null default 0,  -- trigger-assigned; 0 = "assign me"
  source                   text not null check (source in ('design_edit','manual')),
  status                   text not null default 'pending_ack'
                           check (status in ('pending_ack','acknowledged','void')),
  description              text not null,
  total_before_cents       integer check (total_before_cents is null or total_before_cents >= 0),
  total_after_cents        integer check (total_after_cents  is null or total_after_cents  >= 0),
  version_before           integer,            -- design_versions refs (design_edit source)
  version_after            integer,
  ack_method               text check (ack_method in ('signature','verbal')),
  acknowledged_at          timestamptz,
  acceptance_id            uuid references public.design_acceptances(id),
  verbal_rep_name          text,
  verbal_conversation_date date,
  verbal_note              text,
  verbal_recorded_by       uuid,               -- trigger-stamped auth.uid(), never trusted
  created_by               uuid,               -- trigger-stamped
  created_at               timestamptz not null default now(),
  updated_at               timestamptz not null default now(),
  voided_at                timestamptz,
  void_reason              text,
  unique (client_id, short_code, co_no),
  -- An acknowledged row must carry its evidence, whichever kind it is.
  constraint change_orders_ack_shape check (
    status <> 'acknowledged'
    or (ack_method = 'signature' and acceptance_id is not null)
    or (ack_method = 'verbal' and verbal_rep_name is not null and verbal_conversation_date is not null)
  ),
  constraint change_orders_order_client_fk
    foreign key (order_id, client_id) references public.orders (id, client_id)
);

-- THE INVOICE GATE'S index: send_invoice's pending check is one indexed EXISTS.
create index if not exists change_orders_pending_idx
  on public.change_orders (client_id, short_code) where status = 'pending_ack';
create index if not exists change_orders_code_idx
  on public.change_orders (client_id, short_code, created_at desc);

-- The signature record points back at the CO it acknowledges (column existed since 124;
-- the FK had to wait for this table).
do $$ begin
  alter table public.design_acceptances
    add constraint design_acceptances_co_fk
    foreign key (change_order_id) references public.change_orders(id);
exception when duplicate_object then null; end $$;

-- ── The guard trigger: the rules RLS cannot express ─────────────────────────────────────
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

  if new.ack_method = 'signature' and old.ack_method is distinct from 'signature' and not v_trusted then
    raise exception 'a signature acknowledgment can only be recorded by the signing flow';
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

-- ── RLS: tenant-scoped browser access, with the INSERT shapes bounded ───────────────────
alter table public.change_orders enable row level security;
revoke all on public.change_orders from anon;
grant select, insert, update on public.change_orders to authenticated;
revoke delete, truncate on public.change_orders from authenticated;

drop policy if exists change_orders_owner_select on public.change_orders;
create policy change_orders_owner_select on public.change_orders
  for select to authenticated using (client_id = public.current_client_id());

-- A browser may create a pending CO, or a verbal-acknowledged one (the attestation act).
-- The signature shape is unreachable here (trigger), but the policy narrows it anyway —
-- defence in depth over a table that records agreements.
drop policy if exists change_orders_owner_insert on public.change_orders;
create policy change_orders_owner_insert on public.change_orders
  for insert to authenticated
  with check (
    client_id = public.current_client_id()
    and (status = 'pending_ack' or (status = 'acknowledged' and ack_method = 'verbal'))
  );

drop policy if exists change_orders_owner_update on public.change_orders;
create policy change_orders_owner_update on public.change_orders
  for update to authenticated
  using (client_id = public.current_client_id())
  with check (client_id = public.current_client_id());

-- Rollback:
--   drop trigger if exists change_orders_guard_trg on public.change_orders;
--   drop function if exists public.change_orders_guard();
--   alter table public.design_acceptances drop constraint if exists design_acceptances_co_fk;
--   drop table if exists public.change_orders;
