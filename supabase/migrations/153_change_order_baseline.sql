-- 153_change_order_baseline: designs.accepted_snapshot — the priced design as of the
-- customer's LAST AGREEMENT. The column the change-order code has always needed and never had.
--
-- THE DEFECT (audit finding 16, four failed fixes before this one). Both `design_edit`
-- change-order writers — submit-estimate's post-acceptance resubmit and portal-settings'
-- stage_order_attribute_change — derive "what the customer agreed to" from
-- `designs.estimate_lines`, and both OVERWRITE that same column in the same handler that
-- raises the CO. So the second resubmit diffs against the first resubmit's unacknowledged
-- revision: `change_orders.total_before_cents` becomes a total the customer never approved,
-- the generated description shows only the latest increment, and the customer signs both.
-- Downstream, `_shared/estimateLines.ts`'s `alreadyInSnapshot` assumes the acknowledged COs
-- form a contiguous chain (CO(k).total_before == CO(k-1).total_after); a moved baseline
-- breaks the walk and the invoice prints a phantom "Change order CO-n" line paired with a
-- cancelling "Order adjustment".
--
-- WHY A NEW COLUMN AND NOT ONE OF THE EXISTING ONES. Nothing stored the signed LINES:
--   * `design_versions` (031) has selections, items, geometry — but NO estimate_lines, so it
--     cannot reconstruct a priced baseline. `change_orders.version_before` points at an
--     unpriced row.
--   * `design_acceptances` (124) stores the signed TOTAL and design_version, not the lines.
--   * `change_orders.snapshot_before` (127) is the ORDER SCREEN'S UNDO POINT — the state
--     void_change_order restores. Stamping it on designer-raised COs enrols them in a restore
--     that rewrites 3 of the 9 columns a designer resubmit touches, and reports
--     `reverted: true` over half-restored data. It is not a baseline and must not become one.
-- Carrying the baseline forward ON the CO row cannot work either: voiding a designer CO
-- restores nothing, so the next resubmit inserts a fresh CO with no prior row to carry from
-- and reads its baseline straight off the live revision again.
--
-- The baseline is a property of the DESIGN'S LAST AGREEMENT, so it lives on `designs`.
--
-- Hand-apply via the SQL editor / MCP and record as version 153 — NEVER `supabase db push`.
-- Apply this BEFORE deploying submit-estimate / portal-settings: both add accepted_snapshot
-- to a `.select()`, and against a schema without the column PostgREST errors — which
-- submit-estimate turns into `Design {id} not found` (404), killing every SS-mode submission.

alter table public.designs
  add column if not exists accepted_snapshot jsonb;

comment on column public.designs.accepted_snapshot is
  'The design AS THE CUSTOMER LAST AGREED TO IT: {estimateLines, selections, paintColors} '
  '(shape mirrors change_orders.snapshot_before). Written at initial acceptance by '
  'customer-accept, and re-stamped by change_orders_stamp_agreed() on every acknowledged '
  'design_edit change order. The ONLY legitimate baseline for a change order — '
  'designs.estimate_lines is not, because the CO writers overwrite it in the same handler.';

-- ── Backfill: accepted designs, in TWO arms ──────────────────────────────────────────────
-- A design with a pending design_edit CO has already had estimate_lines overwritten by the
-- revision, so stamping the current row would enshrine the unacknowledged revision as "the
-- agreement" — the precise harm this migration exists to end.
--
-- But "skip it" is only harmless for the DESIGNER-raised kind. A pending CO that carries
-- snapshot_before was raised or adopted from the ORDER SCREEN, and portal-settings read
-- exactly that column as its baseline right up until this migration. Skipping those rows
-- does not leave them where they were — it silently MOVES their baseline forward onto the
-- staged revision, because agreedBaseline() with a NULL accepted_snapshot falls through to
-- estimate_lines, which the staging already rewrote. An order signed at $10,000 with a roof
-- colour staged to $10,200 would have the next staging price from $10,200: the roof sentence
-- disappears from the change order along with the $200, and the customer signs a "previous
-- total" they never agreed to. That is this migration's own bug, reintroduced by its backfill.
--
-- ARM 1 therefore lifts snapshot_before into accepted_snapshot. It is not a licence to treat
-- that column as a baseline in CODE (the header above still stands, and nothing reads it as
-- one) — it is a one-time recovery of the exact value the old code used for these rows, so
-- their behaviour does not move on the day this lands. It is the safer of the two offered
-- fixes for that reason: teaching agreedBaseline() to fall back to snapshot_before would make
-- the same equivalence a PERMANENT rule for every future row, including the adopted COs where
-- snapshot_before holds a designer's unacknowledged revision rather than the agreement.
update public.designs d
   set accepted_snapshot = c.snapshot_before
  from public.change_orders c
 where d.accepted_at is not null
   and d.accepted_snapshot is null
   and c.client_id = d.client_id
   and c.short_code = d.short_code
   and c.status = 'pending_ack'
   and c.source = 'design_edit'
   -- The same shape test void_change_order makes before it restores from this column, held
   -- to the snapshot's real shape ({lines, discount}) so a JSON `null` in there cannot pass
   -- as a baseline. Spelled without the jsonb `?` operator on purpose: this file is
   -- hand-applied, and several clients bind a bare `?` as a parameter placeholder.
   and jsonb_typeof(c.snapshot_before -> 'estimateLines') = 'object'
   -- Two pending design_edit COs and we cannot tell which one holds the agreement, so take
   -- neither — the same defence in depth the stamp trigger below spells out. There is no
   -- unique index behind the "only ever one" claim, only both writers upserting.
   and not exists (
     select 1 from public.change_orders c2
      where c2.client_id = d.client_id
        and c2.short_code = d.short_code
        and c2.id <> c.id
        and c2.status = 'pending_ack'
        and c2.source = 'design_edit');

-- ARM 2: everything else, from the live row. What is still skipped after arm 1 is the
-- DESIGNER-raised kind (plus the two-pending case arm 1 declines to guess at), which stamps
-- no snapshot_before — and for those the old code and the new one BOTH fall through to the
-- live design, so skipping changes nothing today. Their
-- signed lines are genuinely unrecoverable (design_versions has no prices): accepted_snapshot
-- stays NULL and agreedBaseline() falls back to today's behaviour for that one CO. Operator
-- clean-up is to void the pending CO and have the designer resubmit; the trigger below then
-- stamps correctly from the next acknowledgment onward.
-- Do NOT "improve" this by backfilling everything.
update public.designs d
   set accepted_snapshot = jsonb_build_object(
         'estimateLines', d.estimate_lines,
         'selections',    d.selections,
         'paintColors',   d.paint_colors)
 where d.accepted_at is not null
   and d.accepted_snapshot is null
   and not exists (
     select 1 from public.change_orders c
      where c.client_id = d.client_id
        and c.short_code = d.short_code
        and c.status = 'pending_ack'
        and c.source = 'design_edit');

-- ── The stamp: a TRIGGER, because acknowledgment happens in THREE writers ────────────────
-- customer-accept's ack_change_order (signature, service role) and the order card's two
-- verbal paths (portal/04-orders.jsx createCo and recordVerbal, direct RLS from the
-- BROWSER). Edge code cannot cover the browser ones. This is migration 126's own doctrine:
-- the unbypassable rules live in a trigger.
--
-- It goes on `change_orders`, NOT on `designs`: designs already carries at least one
-- out-of-band trigger this repo does not define (designs_ensure_order — see
-- customer-accept's order upsert note), and stacking on it is how surprises happen.
create or replace function public.change_orders_stamp_agreed()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $fn$
begin
  -- A MANUAL change order moves the total, never the lines — the agreed design is unchanged.
  if new.source <> 'design_edit' then return null; end if;
  if new.status <> 'acknowledged' then return null; end if;
  -- Already acknowledged before this statement: the guard trigger freezes such rows, and a
  -- later touch (a void, an ack_* rewrite) must not re-stamp a baseline that has moved on.
  -- Nested rather than `tg_op = 'UPDATE' and old.status = ...`: SQL's AND does not promise
  -- short-circuit evaluation, and OLD does not exist on INSERT (126's guard nests for the
  -- same reason).
  if tg_op = 'UPDATE' then
    if old.status = 'acknowledged' then return null; end if;
  end if;
  -- Defence in depth. There is only ever ONE pending design_edit CO per design (both writers
  -- upsert), so this should never fire — but if a second one ever exists, the design carries
  -- a revision nobody has agreed to and stamping it would be exactly the original bug.
  if exists (
    select 1 from public.change_orders c
     where c.client_id = new.client_id
       and c.short_code = new.short_code
       and c.id <> new.id
       and c.status = 'pending_ack'
       and c.source = 'design_edit'
  ) then return null; end if;

  -- The design as it stands at acknowledgment IS what was just agreed to, PROVIDED the
  -- revision reached the row before the CO did — because this reads designs, not the CO.
  -- portal-settings' stage_order_attribute_change has always satisfied that (it updates the
  -- design, then writes the CO). submit-estimate did NOT: its one persist of estimate_lines
  -- sits below the change-order block AND below the email, and it has an anticipated failure
  -- path (ss_quote_persist_failed, which still returns ok) — so a failed persist left a CO the
  -- customer could sign while the design still held the OLD lines, and this trigger would then
  -- freeze those as the agreement. It now writes the revision to designs immediately before
  -- the CO block on the post-acceptance path, so the invariant is true for both writers.
  -- If that early write itself fails the CO block still runs and the stamp is whatever the row
  -- last held — the same value as before 153, never a worse one — and the persist below it
  -- reports the failure durably.
  -- The total the customer signed (total_after_cents) is totalFromSnapshot of exactly these
  -- lines, which is what makes the acknowledged chain contiguous.
  update public.designs d
     set accepted_snapshot = jsonb_build_object(
           'estimateLines', d.estimate_lines,
           'selections',    d.selections,
           'paintColors',   d.paint_colors)
   where d.client_id = new.client_id
     and d.short_code = new.short_code;

  return null;
end;
$fn$;

revoke execute on function public.change_orders_stamp_agreed() from public, anon, authenticated;

drop trigger if exists change_orders_stamp_agreed_trg on public.change_orders;
create trigger change_orders_stamp_agreed_trg
  after insert or update of status on public.change_orders
  for each row execute function public.change_orders_stamp_agreed();

-- Rollback:
--   drop trigger if exists change_orders_stamp_agreed_trg on public.change_orders;
--   drop function if exists public.change_orders_stamp_agreed();
--   alter table public.designs drop column if exists accepted_snapshot;
