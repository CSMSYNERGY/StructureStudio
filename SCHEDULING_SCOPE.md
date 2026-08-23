# Build Schedule + Delivery Schedule + Repairs — Scoping Document

**Status: ALL FIVE PHASES SHIPPED TO BETA 2026-08-04** (mockup approved by Carolyn same
day, after four rounds: kanban → load planner → drivers/trucks → corridor territories).
Phase 1 = migrations 087–091 + portal-schedule (applied live + deployed). Phase 2 = Build
Schedule tab. Phase 3 = Repairs tab. Phase 4 = Load Planner + Drivers/Territories on
Settings → Team + the sync-design-status delivered fence (deployed). Phase 5 = week
calendar + the entitlement gate (`schedUnlocked` = operator OR
`entitlement.features.schedule_builds`) + available-now teaser CTAs.

**LAUNCH SWITCH 1 — ✅ THROWN.** `billing_plans.availability = 'available'` for
`schedule_builds` (migration `094_scheduler_available`), repriced to **$195/mo · $1,950/yr**
with `price_visible = true` — verified live 2026-08-07. The $250/mo and "price_visible stays
false" written elsewhere in this document are the pre-launch plan, not the current state.
**PAY-ONLY (Carolyn 2026-08-04: "No one gets grandfathered into this"):** portal-billing's
`PAID_ONLY_FEATURES` excludes `schedule_builds` from the exempt/transition blankets —
grandfathered, internal, and free-period tenants all need a real subscription like everyone
else (deployed + diff-verified same day).

⚠️ **LAUNCH SWITCH 2 — STILL PENDING.** The What's New entries (hand-authored INSERT into
`release_notes`; NO pricing per CLAUDE.md). Switch 1 is live *without* it, so tenants can
subscribe today and nothing in the product announces the feature. Drafted as migration
`104_scheduling_release_notes.sql` — it is a publication to every tenant, so a human runs it.
The entries publish as **status='beta'** ("On beta for testing", migration 103) and the
Monday merge workflow flips them to Live — see CLAUDE.md's release-notes section for the
process.

## Second beta walkthrough — Carolyn, 2026-08-21 (decisions 18–23)

Seven fixes from her walking the Build Schedule tab. All in `portal/05-schedule.jsx` except
23, which also touches `portal-schedule`.

18. **The job card's destructive button says REMOVE.** The confirm, the toast and the
    activity verb already did, and it is the honest word — the job leaves the board and the
    order/design/inventory unit is untouched. **Repairs and Loads keep "Delete"** on purpose:
    those really destroy the record, and softening them would understate what they do.
19. **The Table view SEGMENTS, and segmenting is not filtering** — "I might want to see the
    ENTIRE LIST, but segmented by crews". Every job stays on screen, bucketed into labelled
    sections: crew, build date, week, style, size, source, stage. One table, group headers as
    full-width rows, so the nine columns stay aligned (deliberately NOT the delivery pool's
    table-per-group shape). The chosen sort applies *within* a group; group order comes from
    the mode, never from `sortKey`. **The invariant: no mode may ever drop a row.**
20. **Building style is DERIVED, not a column.** `building_label` is the composed
    "`<Style> <Size>`" string, so stripping `parseSize`'s shape leaves the style — no
    migration and, unlike a real column, no backfill. Assumes no tenant names a style
    containing `number x number`. If that ever breaks, add the column; don't patch the regex.
21. **Calendar detail is a MODAL** — ~~one full-width panel below the grid~~ **superseded
    within the day by decision 24 below.** The problem it solves is unchanged: a day column
    is a hard-coded 218px and a month cell narrower still, so the form had nowhere to go and
    its right-hand fields ran off the card. Month view no longer navigates away to show
    detail; "Open that week" is an explicit control (month only).
22. **Month view is a first-class scheduling surface**: pills drag (the day cells were
    already drop targets — it was half a loop), and read two lines, building first per
    decision 14.
23. **Day headers show the value scheduled for that day and that crew.** Free on the crew
    axis, because the calendar already buckets *after* the crew filter. Two rules:
    - **`build_jobs` gets NO price column.** An order's total is routinely set *after* the
      build job exists, so a creation-time snapshot would be null exactly when it matters and
      would never catch up. `build_board` computes `valueCents` per read from whichever
      source row owns the money (`orders.total_cents` / `inventory_units.asking_price_cents`
      / `repairs.quote_cents`; a manual job never has one).
    - **A missing total is never rendered as $0.** The known sum shows with an explicit gap
      marker — Orders' rule, "we never show a guessed number". Treating NULL as zero silently
      understates the day while looking authoritative.
    - **Visible to everyone with Build Schedule access — no role gate** (Carolyn's call, made
      after the trade-off was put to her). A `crew_leader` on the shop floor sees daily
      revenue, where Orders is operator-only and Billing is owner-granted. If that should
      ever change, the hook is one condition on the header plus the `access` prop the tab
      already receives — no migration is stranded by shipping it open.

24. ⚠️ **DECISION 6 IS REVERSED FOR THE CALENDAR: the job detail is a popup.** Carolyn, same
    day, after using the panel from 21: *"I don't really like the edit field being below the
    calendars. I think it needs to be a popup screen."* So the calendar's job detail is now a
    **modal** — centred card, backdrop, closes on ×, Escape, or a click outside — built on
    the same shell `SchedStageEditor` already uses.

    **Read this before "fixing" it back.** Decision 6 says "Everything at face value — no
    popouts… detail drawers/modals for job info are out", and that rule is still in this
    document above. It was set by Carolyn and it has now been narrowed by Carolyn, so the
    scope is exactly:
    - **Calendar (week + month): a modal.** The 218px day column could never hold the form;
      the inline panel fixed the clipping but she did not want the reading order.
    - ~~**Board and Table: still expand in place.**~~ **Superseded by decision 25 below** —
      she found the difference from the Table side two days later and asked for uniformity.

    Decision 6 still governs the *card and row faces* — sizes, dates, phones, colours, build
    status all stay on the face, and no detail lives only behind a click.

25. **THE POPUP IS THE ONE DETAIL SURFACE FOR THE WHOLE BUILD SCHEDULE TAB** (Carolyn
    2026-08-23: *"For uniformity and User experience it is IMPORTANT to have things
    functioning the same"* — after clicking to edit in Table view and getting the inline
    expansion instead of the popup). Board cards and Table rows no longer expand in place;
    every click opens the same modal, Escape and click-outside close it in every view, and
    the open card/row is marked the same way everywhere (ACCENT outline; tint on the table
    row). Decision 6's no-popouts rule is now fully reversed for this tab's JOB DETAIL —
    the faces still show everything, per decision 6's surviving half.

    The same uniformity pass also: gave the Board's stage columns the $ + sq ft summary the
    other groupings already had (summary only — no blue tint; the board keeps its kanban
    gray), and made TRAY items draggable in every view — onto a day (calendar), onto a
    stage column (board; `create_job` takes `stageId`), onto a day row or date group
    (table). A tray item has no date/crew/stage yet, so in the table only date-shaped
    targets accept it; others ignore the drop and do not light up during the drag.

Also fixed: **Refresh gave no sign it ran.** It always refetched, but set no busy state,
never disabled, and left a stale banner up — so on an unchanged board the screen was
byte-identical and the button read as dead. And an expanded card kept pre-refresh values,
because `SchedJobEditor` seeds its form state once and React keeps it; it is now keyed on
`updated_at`, which re-seeds the form and re-reads the history together. ⚠️ The same three
defects remain in **Repairs, Delivery Schedule and Drivers & Territories** — Carolyn scoped
this pass to Build Schedule, so they are a known follow-up, not an oversight.

## Post-launch refinements from beta testing (2026-08-04 → 08-05)

The decisions below supersede parts of the original spec. Migrations 092–095.

13. **Every non-repair build job appears in the delivery pool** — an inventory spec build is
    hauled shop → sales lot, which is a delivery. Consequence: a unit rides TWO loads over
    its life (spec haul, then the sale), so migration 092 dropped the one-stop-per-unit
    index in favour of "one OPEN stop at a time"; the sale stop carries the buyer's design
    code and drives the delivered write-back.
14. **The card reads building-first** (migration 093): style+size headline → roof type →
    color swatches (hexes snapshotted from the tenant's `colors` catalog) → customer, with
    the serial and source pill kept. Repairs lead with the work, then the building. Applies
    to the tray rows too.
15. **Crews, not individuals, are the build scheduling unit** (094). Named `build_crews`
    with a color; logins optional. The calendar flips per crew and a drop assigns that crew.
16. **The Build Schedule calendar is the main view**: real dates, Sunday-first, week +
    month, weekends on/off, **one build date per job** (dropping on a day is the
    reschedule), and exactly ONE Unscheduled tray above the calendar — it holds undated
    jobs *and* intake items, and dropping an intake item on a day creates it scheduled.
17. **Drivers are name-first** (095): typed `display_name`, ~~portal login optional~~
    **— CORRECTED by migration 101 (Carolyn, 2026-08-06): every driver is a team member with
    a login.** A driver signs in to see their loads and mark a delivery done, and per-person
    access (100) can only attach to something you can sign in as. `display_name` survives as
    an optional label on top of their real name. Loads
    reference the driver *profile*. Settings → Team shows drivers (and crews, and
    territories) as one-liners that expand on Edit, matching Sales Locations.
This is the planning doc for the "Schedule Builds and Delivery" feature (billing key
`schedule_builds`, already defined in migration 052 at $250/mo, `availability='coming_soon'`)
plus the full Repairs tab. Both `build-schedule` and `delivery-schedule` exist today as
ComingSoon stubs in portal.html and are already in `NONADMIN_TABS`.

## Product decisions (made 2026-08-03, Carolyn)

1. **Two independent schedules, cross-readable.** Build Schedule and Delivery Schedule are
   separate lists — a job is added to each deliberately, not auto-flowed. But each side can
   see the other: a delivery shows its building's build status, a build job shows the load
   it rides on. The invariant the cross-link enforces: **you can never deliver a building
   that isn't built.** Scheduling a delivery date ahead of time is fine (that's the point —
   the dispatcher reads the build schedule and picks a date after projected completion);
   what's blocked is marking a load out/delivered while any stop's building isn't done, and
   the UI flags a load whose date lands before a stop's build due date.
2. **Custom stages per tenant** (the Monday.com feel) — **Build Schedule only**. Ships with
   defaults; each builder can rename/add/remove/reorder build stages. Every stage carries a
   machine-readable `kind` (`queue | active | done`) so automation never depends on
   user-editable names — the same lesson as the Monday label-ID rule in CLAUDE.md.
3. **Full Repairs tab now** — intake, job tracking, photos, service history tied to the
   building and customer. Not a placeholder.
4. **Crew can update stages.** Any linked team member (`user` role) can move a build job
   between stages and add notes — the shop floor keeps the board live. Creating/deleting
   jobs, setting dates/assignees, load planning, and editing stages stay owner/admin.
5. **The Delivery Schedule is a LOAD PLANNER, not a kanban** (Carolyn, mockup review
   2026-08-03: "the board view is nice to see, but not practical for scheduling"). The unit
   of scheduling is a **load** — one truck, one day, one route — holding ordered **stops**.
   Deliveries are grouped into loads by **area** (one route), **size** (what fits the deck —
   sum of building lengths vs. the truck's deck length, shown as a capacity bar), and
   **build dates** (the to-be-loaded pool groups by area and sorts by built/ready date).
   Stage kanban is dropped for delivery entirely; the tab's views are **Loads** (grouped by
   day) and **Table** (flat list), calendar later.
6. **Everything at face value — no popouts.** All job/load information lives in the row or
   card itself (sizes, dates, phones, destinations, gate codes/site notes, build status).
   Detail drawers/modals for job info are out. The one exception is true configuration UI
   (the stage editor), which is not job data.
7. **Wide loads are the norm, not the edge case.** Any building wider than 8'6" is a wide
   load — which is most of the catalog. The designer knows every building's exact width ×
   length, so the WIDE flag, permit requirement, and deck-fit math are **computed from the
   design, never hand-entered**. Loads carry permit/daylight/route-restriction state.
8. **Auto-planning is the destination** (explicitly later, but the data model must be ready
   from day one): given driver/truck specs and the pool, suggest loads automatically —
   deck-length fitting per driver, stops grouped and ordered by map route, wide-load-legal
   routing, drivers matched to their territories. This is why stops store geocodable addresses and
   buildings store real dimensions. The product already ships a Google Maps API key path in
   the designer config (`googleMapsApiKey` / `DEFAULT_GOOGLE_MAPS_API_KEY`) — routing has an
   integration precedent.
9. **Drivers are people with trucks, set up in Settings → Team** (Carolyn, mockup review
   2026-08-04). Each driver has **their own truck** (deck length, max building width,
   wide-load capability) and **their own territory** — so capacity math is per-driver
   (Ray's loads fill against his 40', Denny's against his 32'), the pool's territory groups
   map to whoever covers them, and the loads view filters by driver ("list drivers and
   their loads"). Driver setup extends the existing team management UI, not a new tab.
9b. **Territories are broad corridors, NOT city lists** (Carolyn, 2026-08-04: "we can't put
   in every city… it must be broader"). A territory is a named region described the way
   you'd tell a new driver, anchored on highways radiating from the home shop. Her real
   example (shop at Linn, MO): **West** — Hwy 50 west of Linn to Kansas City, the I-70
   corridor and everything in between, as far north as the Iowa line; **Southwest** — Linn
   to Springfield & beyond on I-44, down to Rolla, plus Jefferson City; **East** —
   everything east of Linn to St. Louis and Farmington. Territories are defined once for
   the company; a driver can cover more than one and two drivers can share one. A stop is
   assigned to a territory (dropdown in v1, defaulting from prior stops in the same
   city/zip; geocode-based auto-assignment when maps land).
10. **Drop-to-drop distance matters, not just distance from the shop.** Every stop after the
   first shows its **leg** (miles from the previous stop); the load header shows out + back
   totals. Hand-entered in v1, computed by maps later.
11. **Soft rules warn, one hard rule blocks, and the block is overridable** (Carolyn,
   2026-08-04). Territory mismatches and delivery-before-build-due dates **warn but allow**.
   The built-before-delivered rule blocks — but an **owner/admin can override it** with a
   required reason: the confirm offers "Override and send anyway?" + reason text + an
   optional "Also mark the build as Built" (the common case: work done, board stale). The
   override is audit-logged (who/when/why in `schedule_activity`) and the load permanently
   carries an inline "Overridden — <reason> · <name>, <date>" chip. Crew cannot override.
   The ONLY non-overridable rule is physical: a building wider than the assigned driver's
   `max_width_ft` — remedy is reassigning the load or fixing truck specs, not forcing it.
12. **Repairs rides the same billing feature** (Carolyn, 2026-08-04): the `schedule_builds`
   subscription ("Schedule Builds and Delivery", $250/mo) covers Build Schedule, Delivery
   Schedule, AND the Repairs tab. No separate billing key.

## Job sources (the three feeds)

| Source | Backing rows today | Build board | Delivery loads |
|---|---|---|---|
| **Customer order** | `orders` + `designs` (status accepted/invoiced) | Yes — "build for customer X". Mints a shop **serial** from `take_next_serial()` (this is exactly why migration 075 put the counter on `client_settings`). | Yes — becomes a stop on a load once built (or planned ahead against its build due date). |
| **Inventory build** | `inventory_units` + master design (`status='inventory'`) | Yes — builder queues a spec unit for a lot. Unit already owns its serial; the job reuses it. | Only when the unit **sells** — already built, so the stop has no build dependency (pickup point = the lot, not the shop). Lot-to-lot moves also ride loads. |
| **Repair** | **New `repairs` table (this project)** | Shop repairs (building comes in / bench work). | Field visits and pick-up/return hauls ride a load like any other stop. |
| **Manual** | none | Free-form card (e.g. "shop maintenance day") | Free-form stop (e.g. haul a trade-in back) |

## Data model (new migrations, next `NNN_` prefixes; hand-apply, never `db push`)

### `schedule_stages` — per tenant, BUILD board only
`id uuid PK · client_id text · name text · color text ·
kind text CHECK (kind in ('queue','active','done')) · sort_order int ·
archived boolean default false · created_at/updated_at`

- Seed defaults lazily on first board load: **Queue** (queue) → **In Build** (active) →
  **Built** (done).
- Rules: at least one `done` stage; a stage with jobs can be archived but not deleted (jobs
  keep a valid FK); renames are free — nothing keys on names.
- Delivery has NO custom stages (decision 5): a load's lifecycle is fixed
  (`planned → out → delivered`) and a stop's readiness is derived from its build job.

### `build_jobs` — one row per building/repair in the shop
`id uuid PK · client_id text ·
stage_id uuid REFERENCES schedule_stages · position numeric` (float order within stage;
re-space on collision) `·
source text CHECK (source in ('order','inventory','repair','manual')) ·
design_short_code text · order_id uuid · inventory_unit_id uuid REFERENCES inventory_units
ON DELETE SET NULL · repair_id uuid REFERENCES repairs ON DELETE CASCADE ·
serial bigint · title text · customer_name text · building_label text ·
width_ft numeric · length_ft numeric` (snapshot from the design at creation — feeds
deck-fit + wide-load math everywhere) `·
scheduled_start date · due_date date · completed_at timestamptz ·
assignee_user_id uuid · notes text · created_by uuid · created_at/updated_at`

- `customer_name` / `building_label` / dimensions are display snapshots taken at creation
  (same denormalize-for-the-list pattern as OrdersView deriving from `designs.contact`).
  There is no detail drawer (decision 6) — the row IS the detail, so snapshots must be
  complete enough to render everything inline.
- Serial minting: an **order** build job calls `take_next_serial()` at creation (LAST in the
  transaction, after validation — same "a rejected payload must not burn a number" rule as
  `save_inventory`). Inventory/repair jobs carry the existing serial if known.
- Partial unique guards: one build job per `design_short_code`, one per `inventory_unit_id`
  — no accidental duplicate cards for the same building.

### `delivery_territories` — named corridors, defined once per company (decision 9b)
`id uuid PK · client_id text · name text` ("West") `·
description text` ("Hwy 50 west of Linn to Kansas City, I-70 corridor, north to the Iowa
line" — human words, shown wherever the territory appears) `·
sort_order int · active boolean · created_at/updated_at`
Managed on the same Settings → Team page (a "Delivery territories" card). Deliberately no
geometry column in v1 — the description IS the definition; polygons/corridor matching can
arrive with the maps work without a schema change.

### `driver_profiles` — a team member's truck + territory (decision 9)
Keyed `(client_id, user_id)` — the exact shape of `commission_members` (migration 077),
which is the established pattern for per-user capability rows. Managed inside the existing
**Settings → Team** UI (`CommissionTeam`, portal.html:7277), extended with a Driver section.

`client_id text · user_id uuid · is_driver boolean default false ·
truck_name text` ("40' gooseneck") `· deck_length_ft numeric · max_width_ft numeric ·
wide_load_capable boolean default true ·
territory_ids uuid[]` (→ delivery_territories — usually one, but a driver can cover
several and two drivers can share one) `· active boolean · created_at/updated_at ·
PRIMARY KEY (client_id, user_id)`

Service-role-only writes like `commission_members` (revoke from anon/authenticated); reads
come back through the edge function's `loads`/`pool`/`list_drivers` responses. Not every
tenant staffs drivers as employees — a `driver_profiles` row does NOT require a
`client_users` login… **v1 keeps it simple: drivers ARE team members** (they likely need
portal access anyway to mark stops delivered); revisit contractor haulers if a tenant asks.

### `delivery_loads` — one driver (with their truck), one day, one route
`id uuid PK · client_id text · load_no bigint` (per-tenant counter, advisory-lock trigger
like `orders_assign_no()`) `· driver_user_id uuid` (→ driver_profiles) `·
deck_length_ft numeric · max_width_ft numeric` (**snapshots from the driver's profile at
assignment** — capacity math on past loads must not change when a driver upgrades trucks) `·
load_date date · route_label text` ("Shop → Goshen → Middlebury") `·
miles_out numeric · miles_back numeric ·
is_wide boolean` (derived: any stop's building wider than 8.5') `·
permit_status text CHECK (permit_status in ('not_needed','needed','on_file')) ·
status text CHECK (status in ('planned','out','delivered')) default 'planned' ·
departed_at timestamptz · completed_at timestamptz · notes text ·
override_reason text · overridden_by uuid · overridden_at timestamptz` (decision 11 —
set only when an admin forces out/delivered past the built check; rendered as a permanent
inline chip) `·
created_by uuid · created_at/updated_at`

### `delivery_stops` — ordered stops on a load
`id uuid PK · client_id text · load_id uuid REFERENCES delivery_loads ON DELETE CASCADE ·
stop_order int ·
source text CHECK (source in ('order','inventory','repair','manual')) ·
build_job_id uuid REFERENCES build_jobs ON DELETE SET NULL` (the cross-link; null for
already-built lot units and field repairs) `·
design_short_code text · inventory_unit_id uuid · repair_id uuid ·
serial bigint · customer_name text · customer_phone text · building_label text ·
width_ft numeric · length_ft numeric ·
pickup text` ('shop' or a builder_locations id — sold lot units start at the lot) `·
dest_street/city/state/zip text ·
territory_id uuid` (→ delivery_territories — the pool's grouping key and the driver match;
picked from a dropdown in v1, defaulted from prior stops in the same city/zip, geocoded
later) `·
lat/lng numeric` (geocoded when available — the auto-planner's food) `·
leg_miles numeric` (distance from the PREVIOUS stop — from the shop/lot for stop 1;
hand-entered v1, maps later — decision 10) `·
time_window text` ("8–10 AM") `· site_notes text` (gate codes, ground conditions —
face-value data, rendered inline on the load sheet) `·
delivered_at timestamptz · created_at/updated_at`

- A stop may exist with `load_id NULL`? **No** — unassigned deliveries are not rows here;
  the "to be loaded" pool is a **query** (built/in-build order jobs without a stop + sold
  units without a stop + open field repairs without a stop), grouped by `territory_id` and
  sorted by built/ready date. No double bookkeeping.
- Deck-fit: `sum(length_ft)` of a load's stops vs. the load's snapshotted
  `deck_length_ft` (from the assigned driver's profile — per-driver capacity, decision 9),
  shown as a capacity bar; wide flag = any `width_ft > 8.5`. Both computed, never
  hand-entered (decision 7) — dimensions come from the design's own `widthFt`/`heightFt`.
- **Cross-link invariant (server-enforced, mirrored in UI):** a load cannot move to `out`
  or `delivered` while any stop's `build_job_id` points at a job whose stage kind isn't
  `done` — **unless an owner/admin overrides with a reason** (decision 11): the action
  accepts `override: true` + `override_reason`, verifies the admin role, logs an
  `override` activity row, stamps `delivery_loads.override_reason`/`overridden_by`, and
  optionally completes the linked build job in the same call ("Also mark as Built"). Same
  confirm-before-irreversible pattern as `send_invoice`'s operator gate. A `load_date`
  earlier than a stop's build `due_date` is a **flag on the load and the stop** (red), not
  a hard block — plans change; the builder may pull the build forward. The width rule
  (`width_ft > deck max_width_ft`) has NO override — reassign or fix truck specs.

### `repairs` — full tab
`id uuid PK · client_id text · repair_no bigint` (per-tenant counter via advisory-lock
trigger, same pattern as `orders_assign_no()` — repairs do NOT consume building serials) `·
customer_name text · phone text · email text ·
design_short_code text · inventory_unit_id uuid · serial bigint` (all nullable — link the
building when known; serial is the natural lookup the shop uses) `·
description text · status text CHECK (status in
('requested','approved','in_progress','completed','declined')) default 'requested' ·
quote_cents integer · notes text · requested_at timestamptz default now() ·
completed_at timestamptz · created_by uuid · created_at/updated_at`

- Photos: new **private** storage bucket `repair-photos`, paths `{client_id}/{repair_id}/…`,
  uploaded through the edge function (same posture as `feedback-attachments`).
- Repair status is its own small lifecycle (the customer-facing truth); schedule jobs are
  the shop's execution view. Completing the last linked schedule job prompts (not forces)
  marking the repair completed.
- **Service history** = repairs filtered by `serial` / `design_short_code` / customer —
  surfaced on the repair detail ("3 previous repairs on this building") and later on
  Inventory/Designs rows.

### `schedule_activity` — lightweight audit
`id · client_id · subject text ('build_job','load','stop','repair') · subject_id uuid ·
user_id · action text ('moved','created','dated','assigned','noted','completed','loaded','out','delivered') ·
from_stage_id · to_stage_id · detail text · created_at`
Written by the edge function on every mutation. This is what makes crew-wide write access
safe — every move is attributable. Rendered inline (no popouts) as a compact history line
where it matters.

### RLS posture (matches the rest of the product)
All new tables (`schedule_stages`, `build_jobs`, `delivery_territories`, `delivery_loads`,
`delivery_stops`, `repairs`, `schedule_activity`): RLS on, `*_owner_select` for
`authenticated` scoped to `current_client_id()`, **zero write policies** — every write goes
through the edge function (service role) so role gating, operator `can_write`, and audit
all apply. `driver_profiles` is stricter — service-role only, like `commission_members`.
Do not add direct INSERT/UPDATE policies anywhere.

### `designs.delivered_at` + the sync fence ⚠️
Delivery completion needs to *own* delivered state — today `delivered` is only reachable via
`ghl_stage_delivered_id`, which **no tenant has mapped** (portal.html:576 comment). Plan:

- Add `designs.delivered_at timestamptz`. When a stop for an order is marked delivered
  (individually or via its load completing), the edge function sets
  `designs.status='delivered'` + `delivered_at`.
- **Fence `sync-design-status`:** it must treat locally-set `delivered` as terminal — skip
  recompute for rows with `delivered_at IS NOT NULL` (cleaner than relying on its
  promote-only guard, which only applies to incomplete GHL reads). Without this fence the
  next sync would downgrade delivered → invoiced on every tenant, since GHL never reports
  delivered. This is a one-line skip in the same spirit as its existing draft/inventory skip.
- Sold inventory-unit stops flip nothing on `designs` (the sold estimate design already
  carries status); repairs never touch design status.

## Edge function: new `portal-schedule`

Follow the `portal-commissions` precedent (own function, `resolveTenant`, documented action
list in the header) rather than growing `portal-settings` past 2,300 lines. Add
`[functions.portal-schedule] verify_jwt = true` to `supabase/config.toml` (and never
`config push`).

| Gate | Actions |
|---|---|
| READ (any linked role) | `build_board` (stages + jobs + which load each building rides), `loads` (loads grouped by date, stops + legs inline, per-driver deck-fit numbers; filterable by driver), `pool` (to-be-loaded query: built/in-build orders, sold units, open field repairs without a stop — grouped by area with the covering driver annotated, sorted by ready date), `list_repairs`, `list_drivers` (driver_profiles joined to team names) |
| STAFF (any linked role — decision 4) | `move_job` (stage_id + position on the build board), `add_note`, `mark_stop_delivered` (the driver in the field) |
| ADMIN (owner/admin, operator needs `can_write`) | `create_job`, `update_job`, `complete_job`, `delete_job`, `save_stages` (upsert/reorder/archive; validates the one-`done`-stage rule), `create_load` (snapshots the driver's deck/width), `update_load` (date/driver/route/permit/miles), `add_stop`, `update_stop` (window, site notes, address, leg miles), `remove_stop`, `reorder_stops`, `mark_load_out` / `mark_load_delivered` (both enforce the built-before-delivered invariant server-side), `delete_load`, `save_driver` / `save_territory` (upserts — called from the Settings → Team page), `create_repair`, `update_repair`, `delete_repair`, `upload_repair_photo`, `delete_repair_photo` |

Job/stop creation is **pull, not push**: nothing auto-creates rows when a design is
accepted. The build board shows an "Unscheduled" tray and the load planner shows the
"To be loaded" pool — one click adds the job/stop. Keeps the schedule owned by the builder,
avoids clutter for tenants who ignore the feature, and matches "two independent lists …
added deliberately".

Entry points elsewhere in the portal — **ORDERS ONLY** (Carolyn 2026-08-08, superseding the
original "Designs/Orders row + Inventory row" plan, which shipped and was pulled the same
week). "Orders is actually all SALES. Even an inventory building will need delivery so it is
an ORDER." Designs and Inventory are **report** pages: they state status and never schedule.
A single `Schedule` column on the Orders row, gated on the design being **invoiced** —
SOLD = INVOICED, an accepted quote is not a sale:
- **Lot sale** (the order's design is some unit's `sold_design_short_code`): already built,
  so **"Schedule delivery →"** — never a build. Shows "On a load" once it has a stop.
- **Custom build**: **"Add to build schedule"**, replaced by the job's stage chip once on
  the board. It reaches delivery on its own via the pool after it is built.
- Not invoiced yet: "Invoice first", no action.
- Repair detail: **"Schedule shop work"** (build board) / **"Site visit — add to a load"**.

## Portal UI

All portal-only (`portal.html` is exempt from the JSX mirror rule — no component-twin edits,
but `npm run preflight` still lints the inline babel).

### Build Schedule (board + table)
- **Kanban columns = stages.** Cards drag between columns using the same HTML5
  `draggable`/`onDragOver`/`onDrop` primitive already proven in the PricingCsv style-reorder
  (portal.html:2640) — no library. Drop calls `move_job`; optimistic move, revert on error.
- **Card face carries everything** (decision 6 — no detail drawer): serial (tabular-nums),
  customer, building label + size, source chip, dates, assignee initials, and the
  **load chip** (which load/date the building rides, red when the load date precedes the
  build due date).
- **Table view** reusing `SortTh` / `sortRows` / `StatusChips` / `SearchInput` / `CardHead`
  (portal.html:517-733): serial, customer, building, size, source, stage, start/due,
  assigned, load — everything at face value in the row.
- **Stage editor** (admin, modal — config UI, not job data): rename, color, add, archive,
  drag-reorder, `kind` picker — kind explained in plain words ("Which column means the work
  is finished?").
- Crew reality check: cards must be usable on a phone (the shop floor is the writer).
  Single-column stacked board + big touch targets on narrow viewports; stage moves also
  available from a dropdown on the card (drag-drop is miserable on touch).

### Delivery Schedule = the Load Planner (decision 5)
- **"To be loaded" pool** at top: a grouped table (CommissionsReport's grouped-sections
  pattern, portal.html:7453-7773, keyed by `territory_id` instead of period) — serial,
  customer, building, **size**, **WIDE flag**, **built/ready date** (or build stage + due if
  still in build), destination + distance/highway, and an add-to-load control. Each
  territory group header carries the corridor description and the covering driver
  ("WEST — Hwy 50 & I-70 to Kansas City, north to the Iowa line · Ray D."). Grouping by
  territory + sorting by ready date is what makes loads "practically plan themselves".
- **Driver filter chips** above the loads ("All drivers · Ray D. — 40' gooseneck · West (1)
  · Denny S. — 32' flatbed · Southwest (1)") — the "list drivers and their loads" view
  (decision 9).
- **Loads grouped by day** below: each load is a card with a header row (load #, **driver +
  their truck + max width**, route label with **out + back miles**, WIDE LOAD/permit chip,
  **deck capacity bar** — `sum(stop lengths)` vs. the driver's snapshotted deck length) and
  an inline stops table (stop order, serial, customer + phone, building + size, built chip,
  destination + site notes, **leg — miles from the previous stop**, time window). "+ Add
  stop — N′ of deck left" affordance per load. A conflicted load (date before a stop's
  build due) gets a red edge + explicit chip.
- **Table view**: flat list of every delivery — serial, customer, size, destination,
  territory, built, load, date, driver — for filtering/sorting across weeks.
- **No kanban, no popouts.** Site notes, gate codes, phones, legs — all inline; the load
  card prints/reads as the driver's run sheet.
- **⚡ Auto-plan (later, visible as a disabled affordance):** fits pool buildings to each
  driver's deck length, groups by the driver's territories, orders stops by map route,
  respects wide-load-legal routes. Data model is ready for it from day one (dimensions,
  geocodable addresses, per-driver truck specs, described territories).

### Settings → Team: Drivers + Territories (decisions 9, 9b)
Extends the existing team management UI (`CommissionTeam`, portal.html:7277) — same page,
no new tab. Two additions:
- **Driver setup per member**: a Driver toggle, and for drivers: truck name, deck length,
  max building width, wide-load capability, and a **territory picker** (from the company's
  territory list; multiple allowed).
- **Delivery territories card**: name + free-text corridor description + covering
  driver(s), "+ Add territory". Descriptions are written the way you'd brief a new driver
  ("Hwy 50 west of Linn to Kansas City… north to the Iowa line").
Writes go through `portal-schedule`'s `save_driver` / `save_territory`. The Team page is
owner/admin already, which is exactly who should set this.

### Auto-planner architecture (decided 2026-08-04 — built later, designed for now)
Three layers; only the first is bought:
1. **Maps service = Google Maps Platform** (integration precedent: the designer's
   `googleMapsApiKey`). Geocoding API (address → lat/lng once per stop, also powers
   territory auto-suggestion — which corridor/side of the shop an address sits on),
   Distance Matrix/Routes (auto-fills `leg_miles` + `miles_out`/`miles_back`), and waypoint
   optimization (best stop order; shed loads are 2–4 stops, well within limits). Cache
   distances between repeat town pairs; cost is negligible at this volume.
2. **Load building = our own deterministic logic in `portal-schedule`** — NOT an external
   solver and NOT an LLM. The scale (10–30 pending buildings, 2–5 drivers) makes it simple:
   filter pool to built-by-target-date → split by territory per driver → sort by
   promised/ready date → first-fit-decreasing bin-pack against the driver's
   `deck_length_ft`, rejecting anything over their `max_width_ft` → maps API orders the
   stops and prices the legs → emit **draft loads the dispatcher approves**. The planner
   proposes; a human confirms. Every placement must be explainable in one sentence.
3. **Wide-load routing stays human.** Google routes general traffic, not oversize vehicles,
   and the state permit often dictates the legal route anyway. The planner flags WIDE
   (computed from real dimensions), tracks `permit_status`, and treats the maps route as a
   mileage/ordering estimate. If a tenant ever needs true oversize-aware routing, truck
   routing providers (PC*Miler, HERE Truck Routing) slot in behind the same lat/lng data
   with no schema change.

### Delivery calendar
Week-at-a-glance (the ComingSoon blurb already promises it) — a 7-column week grid of load
cards by `load_date`, prev/next week nav. **Phase 5** — loads and table ship first; the
calendar is a second read of the same rows.

### Repairs tab
Replaces the ComingSoon stub: intake form (customer, phone, building lookup by
serial/short-code with "not one of ours" allowed, description, photos), list with
`StatusChips` + search (InventoryTable is the model), detail view with photos, service
history, quote field, the two Schedule buttons, and status controls. Repair statuses are
fixed vocabulary (not tenant-custom) — they're the customer-facing ladder, and reports need
them stable.

### Gating
Both schedule tabs + Repairs sit behind the ONE `schedule_builds` billing feature —
**decided 2026-08-04: Repairs is included in the $250/mo subscription, no separate key**
(decision 12). Padlock pattern like the main gate; the feature flip from `coming_soon` →
`available` is a data change at launch. (Reminder: no release note about pricing or price
visibility, per CLAUDE.md.)

## Build order (phases = shippable slices)

1. **Foundations** — migrations (stages, build_jobs, delivery_territories, driver_profiles,
   delivery_loads, delivery_stops, repairs, activity, `delivered_at`), `portal-schedule`
   function with stage/job/load/driver/territory CRUD + seed defaults, config.toml entry.
   Testable via function calls before any UI exists.
2. **Build Schedule tab** — board UI + table view + unscheduled tray + entry points on
   Designs/Inventory rows + serial minting for order jobs + stage editor.
3. **Repairs tab** — intake, list, detail, photos, service history, schedule buttons
   (build-board jobs only until phase 4).
4. **Delivery Schedule tab (Load Planner)** — pool grouped by territory/ready date (corridor
   descriptions + covering driver in the group headers) + loads by day with per-driver
   deck-fit bars, leg miles, and wide-load flags + driver filter chips +
   built-before-delivered invariant + conflict flags + the Drivers & Territories sections
   on Settings → Team + delivered write-back **+ the sync-design-status fence (same
   deploy)**.
5. **Launch polish** — delivery week calendar, billing flip to `available`, What's New entry
   (feature only — nothing about price), operator docs.

Later / explicitly out of scope for v1: **the ⚡ auto-planner** (deck-length fitting +
map-routed stop order + wide-load-legal routing — the destination, decision 8; ship the
disabled affordance so tenants see where this is going), geocoding + live mileage via maps
(v1 route labels/miles are hand-entered; the columns exist), automatic customer
notifications when a delivery is set (GHL SMS/email), repair invoicing through QBO, capacity
limits (max builds per week), multi-assignee crews, printable run sheets.

## Known landmines (from the codebase, so nobody re-hits them)

- `invoice_sends` is service-role only — paid state for a job card must come from `payments`
  (RLS-readable) or `designs.status`, never from reading `invoice_sends` in the browser.
- The `orders` migrations live on `wip/orders`, not `beta`, and `OrdersView` is
  operator-only today. The schedule reads orders through the edge function (service role),
  so tenant-facing scheduling does **not** require unlocking the Orders tab — but be aware
  the schema files aren't in this branch's `migrations/`.
- Stage automation keys on `kind`, never on stage names (tenant-editable) — the Monday
  "Shipped"→"Completed" rename incident is the cautionary tale.
- Deploy verification: after deploying `portal-schedule` or the `sync-design-status` change,
  download-and-diff (`supabase functions download …`) — "Deployed" is not proof.
- Rebase before every push; preflight runs on push; tenants see beta on the next Monday
  10:00 UTC promotion.
