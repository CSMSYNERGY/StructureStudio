// The tenant data registry: every public table that carries client_id, and every storage bucket,
// with what happens to it when a builder is deleted (2026-10-21, board item "delete_client leaves
// 7 per-tenant tables behind, including crm_contacts").
//
// WHY THIS EXISTS. No table has a foreign key to client_configs, so nothing cascades off the tenant
// row: a table is cleaned up only if delete_client names it. Every new tenant table was one more
// chance to forget, and by 10-21, 62 of the 105 were neither wiped nor reported (seed-test-electrical,
// deleted 10-13 with the current code, still left electrical_items and tenant_setup_items behind).
// The coverage test (_test_stubs/tenantTableCoverage_test.ts, run by preflight) reads every
// migration and fails when a table that gains client_id, or a new bucket, is missing here. Adding
// a tenant table now forces a decision.
//
// THE FATES
//   wipe     The builder's own setup, catalog and working data. `now: true` means delete_client
//            deletes it today. Without `now` the rows are left behind, and reported, until Track G
//            part 2 (one tenant_purge() transaction) lands.
//   cascade  Goes with `parent` through an ON DELETE CASCADE foreign key on a NOT NULL column, so it
//            follows the parent's fate. Still counted after a delete, so a cascade that did not happen
//            shows up instead of being assumed.
//   retain   A financial or signed record. Kept on purpose and reported as `retained`. How long it is
//            kept (forever or N years) is Carolyn's call; nothing purges it today.
//   pending  Names the builder's customers: CRM, messages, calls, customer logins, consent logs.
//            Kept and reported as `leftBehind` until Carolyn decides retention. `proposed` is what we
//            will recommend to her, nothing more.
//   special  Not ordinary tenant data (hand-made backups). Reported, and handled by hand.
//
// delete_client takes its reports (retained, leftBehind, files) and its bucket sweep from this file.
// What it DELETES is still its own explicit list of wipes, and the coverage test holds that list to
// the `now` entries here, both ways.
//
// FOREIGN KEYS that decide the order for part 2 (live on 10-21): invoice_sends and payments are
// kept, and they point at design_acceptances and payment_attempts with NO ACTION, which is why those
// are kept too; change_orders and order_unlocks point at orders the same way. phone_calls points at
// crm_contacts and sms_numbers, crm_notes and crm_activities at crm_contacts, and build_jobs at
// schedule_stages, all NO ACTION. rtp_bom_lines -> rtp_materials is RESTRICT. designs -> crm_deals is
// CASCADE on a nullable column, so today's designs wipe already removes the deals tied to a design.
//
// The repo is public: no client identifiers in here.

export type TenantFate = "wipe" | "cascade" | "retain" | "pending" | "special";

export interface TenantTable {
  fate: TenantFate;
  /** fate "wipe": delete_client deletes it today. */
  now?: true;
  /** fate "cascade": the table whose rows take these with them. */
  parent?: string;
  /** fate "pending": our recommendation for the retention conversation. */
  proposed?: "wipe" | "retain";
  /** No migration creates it (made by hand), so the coverage test cannot see it come or go. */
  outsideMigrations?: true;
  why: string;
}

export const TENANT_TABLES: Readonly<Record<string, TenantTable>> = {
  // ── wipe, deleted by delete_client today ─────────────────────────────────────────────────────
  tax_code_assignments: { fate: "wipe", now: true, why: "Tax codes picked per style and heading; heading keys are shared, so a recreated slug would show them as its own." },
  wallet_accounts: { fate: "wipe", now: true, why: "The prepaid balance. A recreated slug inherited it. The movements are kept (wallet_transactions)." },
  client_feature_grants: { fate: "wipe", now: true, why: "Comped features. A recreated slug inherited them." },
  designs: { fate: "wipe", now: true, outsideMigrations: true, why: "Saved designs and estimates. Older than the repo's migrations (supabase/CUTOVER_HANDOFF.md)." },
  design_versions: { fate: "wipe", now: true, why: "Every saved version of a design (no FK to designs)." },
  captured_leads: { fate: "wipe", now: true, why: "Designer visitors who left their details (no FK to designs)." },
  layout_item_pricing: { fate: "wipe", now: true, why: "Catalog pricing. Its style_id is nullable, so it cannot rely on the styles cascade." },
  colors: { fate: "wipe", now: true, why: "The builder's colour palette." },
  building_size_inclusions: { fate: "wipe", now: true, why: "Catalog." },
  building_sizes: { fate: "wipe", now: true, why: "Catalog." },
  building_styles: { fate: "wipe", now: true, why: "Catalog." },
  client_layout_items: { fate: "wipe", now: true, why: "Catalog." },
  client_settings: { fate: "wipe", now: true, outsideMigrations: true, why: "Older than the repo's migrations. Settings, with the GHL, QuickBooks and Resend connections. Nothing is revoked at those services yet (part 2)." },
  billing_subscriptions: { fate: "wipe", now: true, why: "Mirror of the payment gateway, cancelled there first." },
  billing_customers: { fate: "wipe", now: true, why: "Mirror of the gateway's saved card, removed there first." },
  feedback_submissions: { fate: "wipe", now: true, why: "Bug reports filed from the portal (feedback_comments cascades)." },
  fixture_items: { fate: "wipe", now: true, why: "Door and window catalog." },
  qbo_item_map: { fate: "wipe", now: true, why: "QuickBooks item ids from their company. Tenant-default rows have no style, so they do not cascade." },
  phone_number_requests: { fate: "wipe", now: true, why: "Bring-your-number requests." },
  app_errors: { fate: "wipe", now: true, why: "Error log rows (best-effort wipe)." },
  client_users: { fate: "wipe", now: true, why: "Login-to-builder mapping. A login with no other builder is deleted from auth." },
  client_configs: { fate: "wipe", now: true, outsideMigrations: true, why: "The tenant row itself, deleted last. Older than the repo's migrations." },
  twilio_accounts: { fate: "wipe", now: true, why: "The Twilio account pointer, removed (twilio_account_forget) after the sub-account is closed." },

  // ── cascade ──────────────────────────────────────────────────────────────────────────────────
  style_cladding: { fate: "cascade", parent: "building_styles", why: "Cladding per style." },
  style_wall_heights: { fate: "cascade", parent: "building_styles", why: "Wall heights per style." },
  rtp_bom_lines: { fate: "cascade", parent: "building_sizes", why: "Bill of materials per size. Also RESTRICT on rtp_materials, so it must be gone before those are." },
  customer_design_links: { fate: "cascade", parent: "designs", why: "A customer login's link to a design." },
  invoice_requests: { fate: "cascade", parent: "designs", why: "\"Invoice to approve\" requests." },
  shop_unit_holds: { fate: "cascade", parent: "inventory_units", why: "Holds taken during an online purchase." },
  inventory_unit_photos: { fate: "cascade", parent: "inventory_units", why: "Inventory photo rows (the files are in inventory-photos)." },
  inventory_photo_ai_edits: { fate: "cascade", parent: "inventory_units", why: "AI photo edits of inventory." },
  crm_contact_followers: { fate: "cascade", parent: "crm_contacts", why: "Who follows a contact." },
  crm_contact_people: { fate: "cascade", parent: "crm_contacts", why: "People on a contact." },
  crm_field_changes: { fate: "cascade", parent: "crm_contacts", why: "A contact's edit history." },
  crm_deals: { fate: "cascade", parent: "crm_pipelines", why: "Deals. Also CASCADE from designs when tied to one, and NO ACTION on crm_pipeline_stages and crm_statuses." },
  crm_deal_stage_changes: { fate: "cascade", parent: "crm_deals", why: "A deal's stage history." },
  crm_pipeline_stages: { fate: "cascade", parent: "crm_pipelines", why: "Pipeline stages (deals point at them with NO ACTION)." },
  phone_call_recordings: { fate: "cascade", parent: "phone_calls", why: "Call recordings." },
  phone_voicemails: { fate: "cascade", parent: "phone_calls", why: "Voicemails." },
  phone_routes: { fate: "cascade", parent: "sms_numbers", why: "Call routing per number." },
  delivery_stops: { fate: "cascade", parent: "delivery_loads", why: "Stops on a delivery load, with the customer's address." },

  // ── wipe, NOT deleted today (left behind and reported until part 2) ──────────────────────────
  builder_locations: { fate: "wipe", why: "Sales lots and addresses (designs, inventory_units and client_users point at it with SET NULL)." },
  tenant_setup_items: { fate: "wipe", why: "The onboarding checklist." },
  schedule_stages: { fate: "wipe", why: "Scheduling stages (build_jobs point at them with NO ACTION, so jobs go first)." },
  schedule_activity: { fate: "wipe", why: "Crew activity and override trail." },
  build_crews: { fate: "wipe", why: "Crews." },
  build_jobs: { fate: "wipe", why: "Scheduled build jobs." },
  repairs: { fate: "wipe", why: "Repair jobs." },
  inventory_units: { fate: "wipe", why: "Online inventory units." },
  electrical_items: { fate: "wipe", why: "Electrical catalog." },
  electrical_settings: { fate: "wipe", why: "Electrical settings." },
  insulation_offerings: { fate: "wipe", why: "Insulation catalog." },
  foundation_items: { fate: "wipe", why: "Foundation catalog." },
  interior_wall_coverings: { fate: "wipe", why: "Interior wall catalog." },
  interior_wall_settings: { fate: "wipe", why: "Interior wall settings." },
  window_colors: { fate: "wipe", why: "Window colours." },
  rtp_materials: { fate: "wipe", why: "Real-time pricing materials." },
  rtp_overhead_lines: { fate: "wipe", why: "Real-time pricing overhead." },
  delivery_settings: { fate: "wipe", why: "Delivery settings." },
  delivery_territories: { fate: "wipe", why: "Delivery territories." },
  delivery_loads: { fate: "wipe", why: "Delivery loads." },
  delivery_distance_cache: { fate: "wipe", why: "Cached distance lookups." },
  driver_profiles: { fate: "wipe", why: "Drivers." },
  shop_settings: { fate: "wipe", why: "Online shop settings." },
  shop_requests: { fate: "wipe", why: "Shop checkouts and requests, the inbox copy (the money is in orders and payments)." },
  commission_settings: { fate: "wipe", why: "Commission rules." },
  commission_members: { fate: "wipe", why: "Who earns commission." },
  ai_style_calls: { fate: "wipe", why: "Our own count of AI calibration calls (what the builder was charged is in usage_charges)." },
  phone_devices: { fate: "wipe", why: "Phone app devices and push tokens." },
  phone_quick_sends: { fate: "wipe", why: "Saved quick-send texts." },
  phone_quick_send_seeded: { fate: "wipe", why: "Once-only seeding marker." },
  phone_user_settings: { fate: "wipe", why: "Phone app settings per user." },
  sms_registrations: { fate: "wipe", why: "A2P brand and campaign registration. Close it at Twilio before the row goes." },
  sms_registration_events: { fate: "wipe", why: "The registration's event trail." },
  sms_numbers: { fate: "wipe", why: "Phone numbers. On the parent Twilio account they stay live until released; phone_calls point here with NO ACTION." },

  // ── retain: financial and signed records ─────────────────────────────────────────────────────
  orders: { fate: "retain", outsideMigrations: true, why: "Money that moved (payments cascades from it). No migration creates it." },
  payments: { fate: "retain", outsideMigrations: true, why: "Money that moved. No migration creates it." },
  payment_attempts: { fate: "retain", why: "Card attempts; payments point at them with NO ACTION." },
  invoice_sends: { fate: "retain", why: "Invoices sent." },
  change_orders: { fate: "retain", why: "Signed changes to an order (NO ACTION to orders)." },
  order_unlocks: { fate: "retain", why: "Order unlocks that change orders consume (NO ACTION to orders)." },
  design_acceptances: { fate: "retain", why: "Signed estimates and invoices; invoice_sends and change_orders point at them with NO ACTION. The signature images are in the signatures bucket." },
  billing_charge_attempts: { fate: "retain", why: "Charges to the builder's card." },
  billing_consents: { fate: "retain", why: "What the builder agreed to before a stored card was charged (card-network dispute evidence)." },
  billing_upgrade_credits: { fate: "retain", why: "Credits given on a plan upgrade, with the breakdown." },
  wallet_transactions: { fate: "retain", why: "Every top-up, debit and refund." },
  usage_charges: { fate: "retain", why: "Each metered call, text and 3D generation." },
  tax_lookups: { fate: "retain", why: "Avalara lookups, which Track H turns into charged calls." },
  commission_entries: { fate: "retain", why: "What each rep earned and was clawed back." },

  // ── pending: names the builder's customers; waits on Carolyn's retention decision ────────────
  crm_contacts: { fate: "pending", proposed: "wipe", why: "CRM contacts: names, phone numbers, emails, addresses." },
  crm_notes: { fate: "pending", proposed: "wipe", why: "Notes on contacts (NO ACTION to crm_contacts)." },
  crm_files: { fate: "pending", proposed: "wipe", why: "Files on contacts (contact_id is nullable, so not a cascade)." },
  crm_activities: { fate: "pending", proposed: "wipe", why: "Contact activity (NO ACTION to crm_contacts)." },
  crm_pipelines: { fate: "pending", proposed: "wipe", why: "Pipelines. Setup, not customer data, but deleting one cascades its deals." },
  crm_statuses: { fate: "pending", proposed: "wipe", why: "Statuses (deals point at them with NO ACTION)." },
  sms_messages: { fate: "pending", proposed: "wipe", why: "Text messages with customers." },
  phone_calls: { fate: "pending", proposed: "wipe", why: "Call log (voicemails and recordings cascade from it)." },
  email_sends: { fate: "pending", proposed: "wipe", why: "Emails sent to customers (email_send_events cascades)." },
  email_inbound: { fate: "pending", proposed: "wipe", why: "Emails customers sent in." },
  customer_sessions: { fate: "pending", proposed: "wipe", why: "Customer portal logins." },
  customer_email_otps: { fate: "pending", proposed: "wipe", why: "One-time login codes for customers." },
  sms_consent_log: { fate: "pending", proposed: "retain", why: "Who agreed to receive texts, and when (consent evidence)." },
  sms_opt_outs: { fate: "pending", proposed: "retain", why: "Who said STOP." },

  // ── special ──────────────────────────────────────────────────────────────────────────────────
  _backup_designs_junior_20260702: { fate: "special", outsideMigrations: true, why: "A hand-made backup of one builder's designs from 07-02 (112 revokes browser access)." },
  _bak_designs_junior_20260702: { fate: "special", outsideMigrations: true, why: "The same backup, a second copy." },
  client_configs_styleitem_backup: { fate: "special", why: "020's hand-applied backup of two dropped client_configs columns. Not in the live database on 10-21; a count that finds no table is skipped." },
};

export type BucketFate = "wipe" | "retain" | "pending" | "global";

export interface TenantBucket {
  fate: BucketFate;
  /** delete_client sweeps <clientId>/ in it today (one level, no recursion). */
  now?: true;
  outsideMigrations?: true;
  why: string;
}

export const TENANT_BUCKETS: Readonly<Record<string, TenantBucket>> = {
  "floor-plans": { fate: "wipe", now: true, outsideMigrations: true, why: "Floor plan images, {client}/{file}. Made in the dashboard." },
  branding: { fate: "wipe", now: true, why: "Logos, {client}/{file}." },
  fixtures: { fate: "wipe", now: true, why: "Door and window photos (public), {client}/{file}." },
  "feedback-attachments": { fate: "wipe", now: true, why: "Bug report screenshots." },
  "inventory-photos": { fate: "wipe", why: "Inventory photos (public), {client}/{unit}/{file}: deeper than the one-level sweep." },
  models: { fate: "wipe", why: "3D models per style, {client}/x/y." },
  "repair-photos": { fate: "wipe", why: "Repair photos, {client}/x/y." },
  "customer-uploads": { fate: "pending", why: "What customers sent the builder: site photos, permits, sketches." },
  signatures: { fate: "retain", why: "Signature images behind design_acceptances." },
  "setup-screens": { fate: "global", why: "Onboarding screenshots, not per builder." },
  "pm-attachments": { fate: "global", why: "Our own project board's attachments." },
};

const tables = Object.entries(TENANT_TABLES);

/** The tables delete_client deletes itself. The coverage test holds its wipe calls to exactly this. */
export const WIPED_BY_DELETE: readonly string[] = tables.filter(([, t]) => t.fate === "wipe" && t.now).map(([n]) => n);

/** Kept on purpose. delete_client reports their counts as `retained`. */
export const RETAINED_TABLES: readonly string[] = tables.filter(([, t]) => t.fate === "retain").map(([n]) => n);

/** Every other tenant table. delete_client counts each one after its wipes, and whatever still has
 *  rows is `leftBehind`: cascades that did not happen, pending, not-yet-wiped and special alike. */
export const COUNTED_AFTER_DELETE: readonly string[] = tables
  .filter(([, t]) => !(t.fate === "wipe" && t.now) && t.fate !== "retain")
  .map(([n]) => n);

const buckets = Object.entries(TENANT_BUCKETS);

/** The buckets delete_client sweeps today. */
export const SWEPT_BUCKETS: readonly string[] = buckets.filter(([, b]) => b.now).map(([n]) => n);

/** Every per-builder bucket, looked at after the sweep: what is still under <clientId>/ is reported. */
export const CHECKED_BUCKETS: readonly string[] = buckets.filter(([, b]) => b.fate !== "global").map(([n]) => n);

/** The fate a table really has: a cascade follows its parent's. */
export function effectiveFate(table: string): TenantFate | undefined {
  const seen = new Set<string>();
  let t = TENANT_TABLES[table];
  while (t?.fate === "cascade" && t.parent && !seen.has(t.parent)) {
    seen.add(t.parent);
    t = TENANT_TABLES[t.parent];
  }
  return t?.fate;
}
