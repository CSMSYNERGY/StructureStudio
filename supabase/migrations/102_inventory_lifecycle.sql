-- 102_inventory_lifecycle: an inventory unit has TWO INDEPENDENT AXES, and a sale is an
-- event you can only win once.
--
-- Carolyn, 2026-08-07, after an audit of the Inventory page. Two requirements:
--   "When Inventory is sold, it must become unavailable to sell."
--   "When new inventory is created, we must know the status: Requested, Accepted, In Queue,
--    Scheduled to build, Built, scheduled to be brought to location, available to sell at
--    Location."
-- Plus, in the same conversation: a building CAN be sold before it is built (a customer
-- legitimately buys a spec build that is still in the queue), and the row should read
-- "SOLD — <buyer's first name>".
--
-- 075's single `status` column ('available' | 'sold') could express none of that. It made
-- available and sold mutually exclusive, so it had nowhere to put "sold, still in the build
-- queue"; and it had no rung between "somebody asked for a building" and "it is stock on a
-- lot", so a building that did not exist yet was marked as sellable the moment it was drawn.
--
-- ── Axis 1: BUILD LIFECYCLE — derived, NOT a column ────────────────────────────────────
-- requested → accepted → in_queue → scheduled_build → built → scheduled_delivery →
-- at_location → delivered. Everything from in_queue onward is ALREADY a fact in build_jobs /
-- delivery_stops. Storing a second copy is the same duplicate bookkeeping that "the
-- to-be-loaded pool is a QUERY, not a table" forbids one table over — and a stamped ladder
-- needs a REVERSE transition at every call site that can undo a schedule fact (delete_job,
-- remove_stop, delete_load's cascade, move_job out of a done stage, clearing a due_date, and
-- alsoCompleteBuilds, which writes build_jobs directly and bypasses both move_job and
-- complete_job). Miss one and the unit is pinned to a stale status with no error anywhere.
-- It is derived on read by _shared/inventoryLifecycle.ts, which keys ONLY on
-- schedule_stages.kind, never on the tenant-editable stage NAME.
--
-- What IS stored here are the two facts no schedule event can produce:
--   * accepted_at — the one explicit approval that makes a unit eligible for the queue.
--   * lifecycle_manual + _basis — the owner's correction, and what the schedule said at the
--     moment they made it. The basis is what lets the override survive noise (a stop
--     reorder, a renamed stage) and yield to real news (the crew marks it built). A bare
--     boolean would pin the unit to a wrong state forever with nothing on screen explaining
--     why — strictly worse than the bug it fixes.
--
-- ── Axis 2: SALE — stored, because it has an invariant ─────────────────────────────────
-- sale_state is the compare-and-swap target that makes double-selling impossible on the
-- server rather than by hiding a button. Every claim is
--   update ... where id = ? and client_id = ? and sale_state = 'unsold'
-- Under READ COMMITTED two concurrent claims serialize on the row lock; the loser
-- re-evaluates that predicate against the winner's committed row and matches ZERO rows.
-- Exactly one caller ever gets a row back — no advisory lock, no serializable transaction.
--
-- 'reserved' is deliberately NOT in the vocabulary (Carolyn: "No — just Sold"). The reason a
-- lot business usually wants a hold state is "it isn't built yet so I can't sell it", which
-- the sell-at-any-stage decision deletes; a deposit-taken-but-not-final sale is already
-- visible per-buyer as that estimate's own status. If it is ever wanted, the guard above is
-- already spelled "must be unsold to claim" and does not change.
--
-- sold_design_short_code stops being dead HERE, structurally. It was declared by 075 and
-- migration 092 made it the linchpin of the sale→delivery model, but nothing ever wrote it a
-- value: portal-settings only ever set it to NULL. So the delivered write-back never reached
-- the buyer's estimate, the sale stop never carried the buyer's code, and a delivered unit
-- re-entered the to-be-loaded pool forever. inventory_units_sold_needs_buyer now rejects a
-- sold row that names nobody, so it cannot quietly go back to being null-only.
--
-- SAFE TO BREAK: verified immediately before writing this — 3 inventory_units rows, all on
-- the internal `structure-studio` tenant, all status='available', zero linked customer
-- estimates, zero buyers. No paying tenant has inventory data yet. The old `status` column is
-- dropped by 103, AFTER the edge functions are redeployed, so the deploy window has no
-- PostgREST 400s.

-- ── Inventory units: the two axes ────────────────────────────────────────────────────────
alter table public.inventory_units
  add column accepted_at            timestamptz,
  add column accepted_by            uuid,
  add column sale_state             text not null default 'unsold',
  add column sold_at                timestamptz,
  add column sold_by                uuid,
  -- The buyer's FIRST name only, snapshotted at the sale, for the "SOLD — Dave" label.
  -- Stored rather than joined on purpose: the ecommerce listing Carolyn plans will need to
  -- render this label, and it must be able to do so without any read reaching a customer's
  -- design row. A first name is the most a storefront should ever show. Derived once with
  -- the split submit-estimate already uses (String(contact.name).split(" ")[0]) — contact
  -- names are one flat field in this product, there is no first/last anywhere in storage.
  add column sold_first_name        text,
  add column lifecycle_manual       text,
  add column lifecycle_manual_basis text,
  add column lifecycle_manual_at    timestamptz,
  add column lifecycle_manual_by    uuid;

alter table public.inventory_units
  add constraint inventory_units_sale_state_check
    check (sale_state in ('unsold','sold')),

  -- There is no such thing as an anonymous sale. Carolyn 2026-08-07: a walk-in must be
  -- entered as an estimate first, so every sold building names the estimate that bought it.
  add constraint inventory_units_sold_needs_buyer
    check (sale_state <> 'sold' or sold_design_short_code is not null),

  -- And no sale residue on an unsold unit: releasing a building must clear the buyer too, or
  -- the pool query and the delivered write-back would keep acting on a customer who no
  -- longer has it. A partial clear is rejected rather than silently kept.
  add constraint inventory_units_unsold_is_clean
    check (sale_state = 'sold'
           or (sold_design_short_code is null and sold_at is null
               and sold_by is null and sold_first_name is null)),

  -- An override may only name a rung the SCHEDULE could have produced. requested/accepted
  -- are absent on purpose: those two are owned by the approval action, so there is exactly
  -- one way to move a building between them rather than two that can disagree.
  add constraint inventory_units_lifecycle_manual_check
    check (lifecycle_manual is null or lifecycle_manual in
      ('in_queue','scheduled_build','built','scheduled_delivery','at_location','delivered')),
  add constraint inventory_units_lifecycle_basis_check
    check (lifecycle_manual_basis is null or lifecycle_manual_basis in
      ('requested','accepted','in_queue','scheduled_build','built',
       'scheduled_delivery','at_location','delivered')),
  -- Never one without the other. A manual value with no basis can never expire — that is the
  -- "pinned to a wrong state forever, with no visible reason" failure this design exists to
  -- avoid, and it should be unrepresentable rather than merely avoided in code.
  add constraint inventory_units_lifecycle_manual_paired
    check ((lifecycle_manual is null) = (lifecycle_manual_basis is null));

-- One customer estimate can be the buyer of at most one building. A DIFFERENT property from
-- the compare-and-swap above (which stops two buyers claiming one unit); this stops one
-- buyer being recorded against two units, which is the mis-click shape.
create unique index inventory_units_one_sale_per_design
  on public.inventory_units (client_id, sold_design_short_code)
  where sold_design_short_code is not null;

-- Backs the build tray's "approved, not yet built" query, which replaces
-- .eq("status","available") in portal-schedule. Note the meaning changed with it: a
-- sold-but-unbuilt spec build must STILL appear on the build board, because selling a
-- building does not build it.
create index inventory_units_queueable
  on public.inventory_units (client_id) where accepted_at is not null;

-- ── Invoice type ────────────────────────────────────────────────────────────────────────
-- Carolyn: "EVERY INVOICE needs a TYPE. NEW BUILD / INVENTORY." (plus REPAIR, reserved).
--
-- invoice_sends is where an invoice lives on our side — there is no invoices table; the
-- invoice object itself is created in GoHighLevel by send_invoice and mirrored into
-- QuickBooks. The type is a SNAPSHOT taken when the invoice is raised: untying a design from
-- its unit afterwards must not retroactively change the type of an invoice that has already
-- gone to a customer and into their books.
--
-- 'repair' is reserved and nothing stamps it yet — repairs have no design and no estimate,
-- so they never reach send_invoice. It costs one CHECK value now and saves migrating live
-- financial rows when repair invoicing ships.
--
-- Note orders.order_type deliberately does NOT exist. The only thing that could populate it
-- is the designs_ensure_order trigger, which lives on the unmerged wip/orders branch and
-- cannot be edited from here — and a column whose only writer is unreachable is exactly how
-- sold_design_short_code became dead. OrdersView derives the type instead. When wip/orders
-- merges, add it to that trigger and replace the derivation.
alter table public.invoice_sends
  add column invoice_type text not null default 'new_build';

alter table public.invoice_sends
  add constraint invoice_sends_type_check
    check (invoice_type in ('new_build','inventory','repair'));

-- Backfill from the link that already encodes it, for invoices raised before this column.
update public.invoice_sends s
   set invoice_type = 'inventory'
  from public.designs d
 where d.client_id = s.client_id
   and d.short_code = s.short_code
   and d.inventory_unit_id is not null;

-- ── Backfill the existing units ─────────────────────────────────────────────────────────
-- Explicit rather than relying on the column default, so this file is a complete description
-- of the transition and can be re-read as one.
update public.inventory_units set sale_state = 'unsold' where status = 'available';

-- No row matches today (0 sold). Present so that a re-run against a drifted environment
-- cannot produce a sold row with no buyer, which the CHECK above would then reject
-- mid-migration. A pre-102 sold row has no recorded buyer to recover — there was never a
-- write that stored one — so it is released rather than invented, and the owner re-marks it.
update public.inventory_units
   set sale_state = 'unsold', sold_at = null, sold_by = null, sold_first_name = null
 where status = 'sold' and sold_design_short_code is null;
update public.inventory_units
   set sale_state = 'sold', sold_at = coalesce(sold_at, updated_at, now())
 where status = 'sold' and sold_design_short_code is not null;

-- Every pre-102 unit was saved to Inventory in order to BE sold — that IS the approval.
-- Requiring a retroactive click would make three real buildings un-queueable.
update public.inventory_units
   set accepted_at = coalesce(accepted_at, created_at);

-- Those three are physically standing on a lot right now, but they have no build job and no
-- delivery stop, so the derivation can only see 'accepted'. That gap is precisely what the
-- override exists for. Seed it with basis = what the derivation says, so the first real
-- schedule event about one of them takes over cleanly instead of fighting the pin.
update public.inventory_units
   set lifecycle_manual = 'at_location',
       lifecycle_manual_basis = 'accepted',
       lifecycle_manual_at = now()
 where lifecycle_manual is null;

-- ── RLS: unchanged ──────────────────────────────────────────────────────────────────────
-- 075's owner-SELECT policy covers the new columns, and there are still ZERO write policies:
-- every write goes through portal-settings / portal-schedule under the service role, so
-- per-area access, operator can_write gating and the audit trail all apply. Do not add
-- INSERT/UPDATE policies here.

-- ── Notes for whoever builds the ecommerce listing ──────────────────────────────────────
-- Carolyn 2026-08-07: a sold display keeps its SOLD badge on the storefront for 30 days and
-- then silently falls off the list. The data for that is here (sale_state, sold_at,
-- sold_first_name); the query is:
--
--   where sale_state = 'unsold' or sold_at > now() - interval '30 days'
--
-- Two things that listing will need and does NOT have yet, so they are not assumed here:
-- an anon-readable path (every current anon RPC is short-code-keyed; this table is
-- authenticated-only), and a price-visibility decision — asking_price_cents has no
-- show_pricing-style gate the way get_catalog does.

-- Rollback:
--   drop index public.inventory_units_one_sale_per_design;
--   drop index public.inventory_units_queueable;
--   alter table public.invoice_sends
--     drop constraint invoice_sends_type_check, drop column invoice_type;
--   alter table public.inventory_units
--     drop constraint inventory_units_sale_state_check,
--     drop constraint inventory_units_sold_needs_buyer,
--     drop constraint inventory_units_unsold_is_clean,
--     drop constraint inventory_units_lifecycle_manual_check,
--     drop constraint inventory_units_lifecycle_basis_check,
--     drop constraint inventory_units_lifecycle_manual_paired,
--     drop column accepted_at, drop column accepted_by,
--     drop column sale_state, drop column sold_at, drop column sold_by,
--     drop column sold_first_name,
--     drop column lifecycle_manual, drop column lifecycle_manual_basis,
--     drop column lifecycle_manual_at, drop column lifecycle_manual_by;
