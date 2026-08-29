-- 158_sales_tax: sales tax on StructureStudio-issued quotes and invoices.
--
-- SS mode (client_settings.invoice_in_ghl = false, migration 121) moved the quote and the
-- invoice into StructureStudio. Tax did not come with them. In CRM mode GHL computed it —
-- submit-estimate sets automaticTaxesEnabled and tags Delivery with GHL's Non-Taxable
-- category — but the SS branch returns before any GHL estimate exists, so none of that runs.
-- The result today, right through the ladder migration 136 left us with: the customer accepts
-- a quote whose Total is PRE-TAX, the builder bills that same figure, and the customer e-signs
-- an invoice consent sentence naming it — which freezes into design_acceptances.total as the
-- amount they committed to. Nowhere in that chain does anyone charge sales tax.
--
-- WHAT THIS APPLIES, AND WHY IT IS INERT UNTIL CODE SHIPS:
--
--   catalog `taxable`   Every priced catalog row gains taxable, DEFAULT TRUE — an unedited
--                       catalog behaves as an ordinary taxable catalog and the builder marks
--                       only the exceptions. Nothing reads the column until submit-estimate
--                       starts sourcing it, so applying this alone changes no number.
--                       Taxability is PER ITEM by decision (Carolyn 2026-08-27), not per line
--                       kind: "never assume" — the builder says which of their own products
--                       they charge tax on, the same way they say what it costs.
--                       Note building_styles, not building_sizes: taxability is a property of
--                       the product, not of how big it is.
--
--   ss_tax_rate         The builder's own rate, and the REQUIRED one. NULL means "not set",
--                       deliberately distinct from 0 — the ss_quote_next precedent (121):
--                       refuse rather than invent. portal-settings will not let invoice_in_ghl
--                       go false while this is NULL, so nobody discovers untaxed invoices
--                       after the fact. 0 is a legitimate, EXPLICIT answer (not registered /
--                       not a taxing state).
--                       It is the FALLBACK, not the primary source: rates come from the
--                       delivery address via Avalara per quote, and this covers a lookup that
--                       is unavailable. Address + fallback together mean a document can always
--                       be issued with a number the builder can defend.
--
--   ss_tax_delivery     Whether delivery fees are taxed. FALSE keeps today's behaviour, where
--                       Delivery is the one hardcoded non-taxable line (submit-estimate:1196).
--                       It is a setting rather than a catalog flag because the delivery fee is
--                       typed into the designer, not picked from a catalog.
--
--   design_acceptances  The FREEZE, at INVOICE SIGNATURE — the moment that closes the sale
--   .tax_*              since migration 136 moved the signature off the quote. Quotes and
--                       invoices both re-resolve the rate each time they are issued (Carolyn
--                       2026-08-27: live until signed); sign_invoice is where the figure stops
--                       moving, so it is where the evidence is written. A clicked quote
--                       acceptance records the tax it was shown too — it is what the customer
--                       said yes to — but it is not the commitment.
--                       NOT redundant with the estimate_lines snapshot: a resubmit overwrites
--                       designs.estimate_lines, so without its own copy the signed tax
--                       evidence is destroyed by the next revision. Exactly why
--                       design_acceptances.total already exists (124).
--
-- SAFETY: every statement is additive with a default that preserves current behaviour, and no
-- code reads any of it on apply. Junior Barns and every other invoice_in_ghl = true tenant is
-- untouched by this file and stays untouched until that switch is thrown.
--
-- NUMBERING: renumbered TWICE. It began as 127 (already taken live by order_document), became
-- 148 against a live ledger that then topped out at 147 — and 148 turned out to be taken twice
-- on origin (commission_one_auto_row_per_order, pm_people), with 157 landing while this work
-- was in flight. Check BOTH the live ledger AND `git ls-tree origin/beta supabase/migrations/`
-- before numbering the next one; neither alone is the whole picture, and origin moves fast.
--
-- LEDGER NOTE: applied live 2026-08-28 via MCP as 20260828053440 / '158_sales_tax', with
-- the orders.tax_cents block following as 20260828054326 / '158b_orders_tax_cents'
-- (apply_migration stamps a timestamp version; the name carries the number, the way
-- 120_get_fixtures_window_color_ids and 139_window_sill do). Verified on apply: all 11 columns
-- present, zero catalog rows non-taxable, zero acceptances carrying tax — i.e. no tenant's
-- numbers moved. Insert only; the statements are idempotent and already live.
--
-- Hand-apply via the SQL editor / MCP and record as version 158 — NEVER `supabase db push`.

-- ── Per-item taxability, across the four priced catalogs ────────────────────────────────
alter table public.building_styles
  add column if not exists taxable boolean not null default true;
alter table public.client_layout_items
  add column if not exists taxable boolean not null default true;
alter table public.fixture_items
  add column if not exists taxable boolean not null default true;
alter table public.colors
  add column if not exists taxable boolean not null default true;

comment on column public.building_styles.taxable is
  'false = this style''s building line is not subject to sales tax. Default true.';
comment on column public.client_layout_items.taxable is
  'false = this item''s estimate line is not subject to sales tax. Default true.';
comment on column public.fixture_items.taxable is
  'false = this door/window/ramp line is not subject to sales tax. Default true.';
comment on column public.colors.taxable is
  'false = this color''s paint/roof upcharge line is not subject to sales tax. Default true.';

-- ── The tenant's tax posture ────────────────────────────────────────────────────────────
alter table public.client_settings
  add column if not exists ss_tax_rate     numeric(7,5),
  add column if not exists ss_tax_label    text not null default 'Sales tax',
  add column if not exists ss_tax_delivery boolean not null default false;

-- Bounded in the database as well as in portal-settings: this number multiplies every taxable
-- line on a customer's bill, and a fat-fingered 725 instead of 7.25 is not a rounding error.
alter table public.client_settings
  drop constraint if exists client_settings_ss_tax_rate_range;
alter table public.client_settings
  add constraint client_settings_ss_tax_rate_range
  check (ss_tax_rate is null or (ss_tax_rate >= 0 and ss_tax_rate <= 0.25));

comment on column public.client_settings.ss_tax_rate is
  'Fallback sales tax rate as a FRACTION (0.0725 = 7.25%). NULL = not set, which blocks turning invoice_in_ghl off. 0 is an explicit "I do not collect sales tax".';
comment on column public.client_settings.ss_tax_label is
  'What the tax row is called on the document — "Sales tax", "GST", a state name.';
comment on column public.client_settings.ss_tax_delivery is
  'true = delivery fees are taxed. Default false, which is today''s hardcoded behaviour.';

-- ── The acceptance freeze ───────────────────────────────────────────────────────────────
alter table public.design_acceptances
  add column if not exists tax_rate         numeric(7,5),
  add column if not exists tax_amount       numeric(12,2),
  add column if not exists tax_jurisdiction text,
  add column if not exists tax_source       text;

alter table public.design_acceptances
  drop constraint if exists design_acceptances_tax_source_check;
alter table public.design_acceptances
  add constraint design_acceptances_tax_source_check
  check (tax_source is null or tax_source in ('avalara','fallback'));

comment on column public.design_acceptances.tax_amount is
  'The tax the customer signed under (subject=invoice) or was shown when they accepted (subject=quote). Frozen here because a resubmit overwrites designs.estimate_lines.';
comment on column public.design_acceptances.tax_source is
  'avalara = the delivery address resolved to a rate; fallback = client_settings.ss_tax_rate was used because the lookup was unavailable.';

-- The browser never reads client_settings directly (portal-settings surfaces it), and the
-- catalog tables' existing per-tenant policies already cover a new column, so there is no
-- policy work here. design_acceptances is service-role-write / owner-read as 124 left it.

-- ── The order ledger's tax split (applied as 158b, 2026-08-28) ──────────────────────────
--
-- orders.total_cents becomes TAX-INCLUSIVE for SS orders, which quietly breaks the one reader
-- that treats it as a pre-tax figure: portal-commissions falls back to total_cents when
-- pretax_subtotal_cents is null, and its own base_type is called 'pretax_subtotal'. Without a
-- way to tell a taxed order from an untaxed one, that fallback pays commission on sales tax the
-- builder merely collects for the state. Splitting it is also just correct for the money view:
-- pretax_subtotal_cents + tax_cents = total_cents.
alter table public.orders
  add column if not exists tax_cents integer;

alter table public.orders
  drop constraint if exists orders_tax_cents_nonneg;
alter table public.orders
  add constraint orders_tax_cents_nonneg check (tax_cents is null or tax_cents >= 0);

comment on column public.orders.tax_cents is
  'Sales tax inside total_cents (migration 158). pretax_subtotal_cents + tax_cents = total_cents. NULL = not taxed or not known, distinct from 0 = taxed at 0%.';

-- Rollback:
--   alter table public.orders
--     drop constraint if exists orders_tax_cents_nonneg,
--     drop column if exists tax_cents;
--   alter table public.design_acceptances
--     drop constraint if exists design_acceptances_tax_source_check,
--     drop column if exists tax_rate,
--     drop column if exists tax_amount,
--     drop column if exists tax_jurisdiction,
--     drop column if exists tax_source;
--   alter table public.client_settings
--     drop constraint if exists client_settings_ss_tax_rate_range,
--     drop column if exists ss_tax_rate,
--     drop column if exists ss_tax_label,
--     drop column if exists ss_tax_delivery;
--   alter table public.colors              drop column if exists taxable;
--   alter table public.fixture_items       drop column if exists taxable;
--   alter table public.client_layout_items drop column if exists taxable;
--   alter table public.building_styles     drop column if exists taxable;
