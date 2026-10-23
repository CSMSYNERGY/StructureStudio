// The tenant data registry: every public table that carries client_id, and every storage bucket,
// with what happens to it when a builder is deleted (2026-10-21, board item "delete_client leaves
// 7 per-tenant tables behind, including crm_contacts").
//
// WHY THIS EXISTS. No table has a foreign key to client_configs, so nothing cascades off the tenant
// row. Until 10-21 a table was cleaned up only if delete_client named it, and 62 of the 105 were
// neither wiped nor reported. Now delete_client calls tenant_purge() (migration 321), which deletes
// the builder's rows from EVERY table with a client_id column except the ones this file RETAINS, in
// one transaction. So this file decides what is kept, and what is exported first. The coverage test
// (_test_stubs/tenantTableCoverage_test.ts, run by preflight) reads every migration and fails when a
// table that gains client_id, or a new bucket, is missing here: adding a tenant table forces a
// decision instead of being purged (or kept) by accident.
//
// THE FATES (Ahsan's retention answers, 2026-10-21)
//   wipe     Purged. `export: true` marks the builder's CUSTOMER data (CRM, texts, emails, calls,
//            voicemails, customer logins): delete_client writes it to one ZIP in tenant-exports
//            BEFORE anything is deleted, and refuses the delete if it cannot. `exportDrop` names
//            columns that never leave (login token hashes).
//   cascade  Goes with `parent` through an ON DELETE CASCADE foreign key on a NOT NULL column. The
//            purge deletes it directly anyway (deny by default); the entry records why the order works.
//   retain   Kept forever: money that moved, signed records, and SMS consent evidence. Passed to
//            tenant_purge as its keep list, and reported after a delete as `retained`.
//
// FOREIGN KEYS the purge's passes absorb (live 10-21): invoice_sends and payments are kept and point
// at design_acceptances and payment_attempts with NO ACTION, which is one reason those are kept too;
// change_orders and order_unlocks point at orders the same way. phone_calls points at crm_contacts and
// sms_numbers, crm_notes and crm_activities at crm_contacts, build_jobs at schedule_stages, all NO
// ACTION, and rtp_bom_lines -> rtp_materials is RESTRICT: a refused delete is retried on the next pass.
//
// The repo is public: no client identifiers in here.

export type TenantFate = "wipe" | "cascade" | "retain";

export interface TenantTable {
  fate: TenantFate;
  /** fate "cascade": the table whose rows take these with them. */
  parent?: string;
  /** Customer data: written to the delete-time export before the purge. */
  export?: true;
  /** Columns left out of the export (secrets). */
  exportDrop?: readonly string[];
  /** No migration creates it (older than the repo's migrations, or made by hand), so the coverage
   *  test cannot see it come or go. */
  outsideMigrations?: true;
  why: string;
}

export const TENANT_TABLES: Readonly<Record<string, TenantTable>> = {
  // ── customer data: exported, then purged ─────────────────────────────────────────────────────
  crm_contacts: { fate: "wipe", export: true, why: "CRM contacts: names, phone numbers, emails, addresses." },
  crm_contact_people: { fate: "cascade", parent: "crm_contacts", export: true, why: "People on a contact." },
  crm_contact_followers: { fate: "cascade", parent: "crm_contacts", export: true, why: "Who follows a contact." },
  crm_field_changes: { fate: "cascade", parent: "crm_contacts", export: true, why: "A contact's edit history." },
  crm_notes: { fate: "wipe", export: true, why: "Notes on contacts (NO ACTION to crm_contacts)." },
  crm_files: { fate: "wipe", export: true, why: "Files on contacts; the files themselves are in customer-uploads (contact_id is nullable, so not a cascade)." },
  crm_activities: { fate: "wipe", export: true, why: "Contact activity (NO ACTION to crm_contacts)." },
  crm_pipelines: { fate: "wipe", export: true, why: "Pipelines (deleting one cascades its deals and stages)." },
  crm_pipeline_stages: { fate: "cascade", parent: "crm_pipelines", export: true, why: "Pipeline stages (deals point at them with NO ACTION)." },
  crm_statuses: { fate: "wipe", export: true, why: "Statuses (deals point at them with NO ACTION)." },
  // Migration 330. The builder's own fields on a contact and on a deal, and their relabels of
  // ours. WIPE: it is per-tenant configuration, like the pipelines and statuses above, and a
  // recreated slug must not inherit the old builder's field list. Exported, because the VALUES
  // (crm_contacts.custom, crm_deals.custom) are exported with their rows and are unreadable
  // without these definitions — a key and no label is not an answer to "what did they record?".
  crm_field_defs: { fate: "wipe", export: true, why: "Contact and design/deal field definitions (migration 330); the values ride on the contact and deal rows." },
  crm_deals: { fate: "cascade", parent: "crm_pipelines", export: true, why: "Deals. Also CASCADE from designs when tied to one." },
  crm_deal_stage_changes: { fate: "cascade", parent: "crm_deals", export: true, why: "A deal's stage history." },
  captured_leads: { fate: "wipe", export: true, why: "Designer visitors who left their details (no FK to designs)." },
  sms_messages: { fate: "wipe", export: true, why: "Text messages with customers." },
  phone_calls: { fate: "wipe", export: true, why: "Call log (voicemails and recordings cascade from it)." },
  phone_call_recordings: { fate: "cascade", parent: "phone_calls", export: true, why: "Call recordings: transcripts and summaries here, the audio at Twilio." },
  phone_voicemails: { fate: "cascade", parent: "phone_calls", export: true, why: "Voicemails: transcripts here, the audio at Twilio." },
  email_sends: { fate: "wipe", export: true, why: "Emails sent to customers (email_send_events cascades)." },
  email_inbound: { fate: "wipe", export: true, why: "Emails customers sent in." },
  customer_sessions: { fate: "wipe", export: true, exportDrop: ["token_hash"], why: "Customer portal logins (who and when; never the token)." },
  customer_design_links: { fate: "cascade", parent: "designs", export: true, why: "Which customer login sees which design." },
  customer_email_otps: { fate: "wipe", why: "One-time login codes for customers: nothing worth exporting." },
  lead_form_submissions: { fate: "cascade", parent: "lead_forms", export: true, why: "What visitors typed into a website lead form (migration 325)." },
  meetings: { fate: "wipe", export: true, exportDrop: ["cancel_token"], why: "Meetings booked with customers (migration 326): who, when, and what they wrote. The cancel token is a capability that cancels the booking, so it is never exported." },

  // ── the builder's own setup, catalog and working data: purged ────────────────────────────────
  tax_code_assignments: { fate: "wipe", why: "Tax codes picked per style and heading; heading keys are shared, so a recreated slug would show them as its own." },
  wallet_accounts: { fate: "wipe", why: "The prepaid balance. The movements are kept (wallet_transactions)." },
  client_feature_grants: { fate: "wipe", why: "Comped features." },
  designs: { fate: "wipe", outsideMigrations: true, why: "Saved designs and estimates. Older than the repo's migrations (supabase/CUTOVER_HANDOFF.md)." },
  design_versions: { fate: "wipe", why: "Every saved version of a design (no FK to designs)." },
  layout_item_pricing: { fate: "wipe", why: "Catalog pricing. Its style_id is nullable, so it cannot rely on the styles cascade." },
  colors: { fate: "wipe", why: "The builder's colour palette." },
  building_size_inclusions: { fate: "wipe", why: "Catalog." },
  building_sizes: { fate: "wipe", why: "Catalog." },
  building_styles: { fate: "wipe", why: "Catalog." },
  client_layout_items: { fate: "wipe", why: "Catalog." },
  client_settings: { fate: "wipe", outsideMigrations: true, why: "Older than the repo's migrations. Settings, with the GHL, QuickBooks and Resend connections; delete_client reads them first, then removes the Resend domains and revokes QuickBooks." },
  billing_subscriptions: { fate: "wipe", why: "Mirror of the payment gateway, cancelled there first." },
  billing_customers: { fate: "wipe", why: "Mirror of the gateway's saved card, removed there first." },
  feedback_submissions: { fate: "wipe", why: "Bug reports filed from the portal (feedback_comments cascades)." },
  fixture_items: { fate: "wipe", why: "Door and window catalog." },
  qbo_item_map: { fate: "wipe", why: "QuickBooks item ids from their company. Tenant-default rows have no style, so they do not cascade." },
  phone_number_requests: { fate: "wipe", why: "Bring-your-number requests." },
  app_errors: { fate: "wipe", why: "Error log rows." },
  client_users: { fate: "wipe", why: "Login-to-builder mapping. delete_client reads it first: a login with no other builder is deleted from auth." },
  client_configs: { fate: "wipe", outsideMigrations: true, why: "The tenant row itself. Older than the repo's migrations." },
  twilio_accounts: { fate: "wipe", why: "The Twilio account pointer, removed (twilio_account_forget) after the sub-account is closed." },
  style_cladding: { fate: "cascade", parent: "building_styles", why: "Cladding per style." },
  style_wall_heights: { fate: "cascade", parent: "building_styles", why: "Wall heights per style." },
  rtp_bom_lines: { fate: "cascade", parent: "building_sizes", why: "Bill of materials per size. Also RESTRICT on rtp_materials." },
  invoice_requests: { fate: "cascade", parent: "designs", why: "\"Invoice to approve\" requests." },
  shop_unit_holds: { fate: "cascade", parent: "inventory_units", why: "Holds taken during an online purchase." },
  inventory_unit_photos: { fate: "cascade", parent: "inventory_units", why: "Inventory photo rows (the files are in inventory-photos)." },
  meeting_overrides: { fate: "cascade", parent: "meeting_hosts", why: "A person's days off and one-off hours (migration 326)." },
  // ⛔ A refresh token here is a standing key to a named person's whole calendar, so this row
  // MUST go when the tenant does. It cascades off meeting_hosts; it is listed rather than left
  // implicit precisely so a future reader cannot mistake "not in the registry" for "kept".
  meeting_connections: { fate: "cascade", parent: "meeting_hosts", why: "Google/Outlook tokens for a person's calendar (migration 326). Service-role only, never exported." },
  meeting_busy: { fate: "cascade", parent: "meeting_hosts", why: "Cached busy blocks read from a person's own calendar (migration 326): times only, no titles." },
  inventory_photo_ai_edits: { fate: "cascade", parent: "inventory_units", why: "AI photo edits of inventory." },
  phone_routes: { fate: "cascade", parent: "sms_numbers", why: "Call routing per number." },
  delivery_stops: { fate: "cascade", parent: "delivery_loads", why: "Stops on a delivery load." },
  builder_locations: { fate: "wipe", why: "Sales lots and addresses (designs, inventory_units and client_users point at it with SET NULL)." },
  tenant_setup_items: { fate: "wipe", why: "The onboarding checklist." },
  schedule_stages: { fate: "wipe", why: "Scheduling stages (build_jobs point at them with NO ACTION)." },
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
  lead_forms: { fate: "wipe", why: "Website lead forms (migration 325); submissions and daily counts cascade from them." },
  meeting_hosts: { fate: "wipe", why: "Who is bookable, their public card and their weekly hours (migration 326). Days off, calendar connections and cached busy blocks all cascade from here; the meetings themselves are RESTRICT, so tenant_purge's retry passes clear them first." },
  meeting_types: { fate: "wipe", why: "What can be booked: durations, buffers, notice windows (migration 326)." },
  meeting_settings: { fate: "wipe", why: "Whether the booking pages are live, and their heading and intro (migration 326)." },
  lead_form_daily_stats: { fate: "cascade", parent: "lead_forms", why: "Per-day views, starts and submissions of a lead form." },
  email_templates: { fate: "wipe", why: "Designed email templates (migration 325)." },
  commission_settings: { fate: "wipe", why: "Commission rules." },
  commission_members: { fate: "wipe", why: "Who earns commission." },
  ai_style_calls: { fate: "wipe", why: "Our own count of AI calibration calls (what the builder was charged is in usage_charges)." },
  phone_devices: { fate: "wipe", why: "Phone app devices and push tokens." },
  phone_quick_sends: { fate: "wipe", why: "Saved quick-send texts." },
  phone_quick_send_seeded: { fate: "wipe", why: "Once-only seeding marker." },
  phone_user_settings: { fate: "wipe", why: "Phone app settings per user." },
  sms_registrations: { fate: "wipe", why: "A2P brand and campaign registration. On our parent Twilio account the brand stays until released by hand (reported)." },
  sms_registration_events: { fate: "wipe", why: "The registration's event trail." },
  sms_numbers: { fate: "wipe", why: "Phone numbers. On our parent Twilio account they stay live until released by hand (reported)." },
  _backup_designs_junior_20260702: { fate: "wipe", outsideMigrations: true, why: "A hand-made backup of one builder's designs from 07-02 (112 revokes browser access)." },
  _bak_designs_junior_20260702: { fate: "wipe", outsideMigrations: true, why: "The same backup, a second copy." },
  client_configs_styleitem_backup: { fate: "wipe", why: "020's hand-applied backup of two dropped client_configs columns. Not in the live database on 10-21." },

  // ── retain: kept forever ─────────────────────────────────────────────────────────────────────
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
  tax_lookups: { fate: "retain", why: "Avalara lookups, each a billed call (319 tracks the charge)." },
  commission_entries: { fate: "retain", why: "What each rep earned and was clawed back." },
  sms_consent_log: { fate: "retain", why: "Who agreed to receive texts, and when: our proof if a text is ever disputed." },
  sms_opt_outs: { fate: "retain", why: "Who said STOP: the same proof." },
  deleted_clients: { fate: "retain", why: "The tombstone itself (migration 321): blocks the id for good. tenant_purge never purges it either way." },
};

export type BucketFate = "wipe" | "retain" | "global";

export interface TenantBucket {
  fate: BucketFate;
  /** fate "wipe": customer files, put in the delete-time export (under a size cap) before the sweep. */
  export?: true;
  outsideMigrations?: true;
  why: string;
}

export const TENANT_BUCKETS: Readonly<Record<string, TenantBucket>> = {
  "floor-plans": { fate: "wipe", outsideMigrations: true, why: "Floor plan images, {client}/{file}. Made in the dashboard." },
  branding: { fate: "wipe", why: "Logos, {client}/{file}." },
  fixtures: { fate: "wipe", why: "Door and window photos (public), {client}/{file}." },
  "feedback-attachments": { fate: "wipe", why: "Bug report screenshots." },
  "inventory-photos": { fate: "wipe", why: "Inventory photos (public), {client}/{unit}/{file}." },
  "form-assets": { fate: "wipe", why: "Lead form and email template images (public), {client}/{file}." },
  models: { fate: "wipe", why: "3D models per style, {client}/x/y." },
  "repair-photos": { fate: "wipe", why: "Repair photos, {client}/x/y." },
  "customer-uploads": { fate: "wipe", export: true, why: "What customers sent the builder, and CRM files: exported, then swept." },
  signatures: { fate: "retain", why: "Signature images behind design_acceptances." },
  "setup-screens": { fate: "global", why: "Onboarding screenshots, not per builder." },
  "pm-attachments": { fate: "global", why: "Our own project board's attachments." },
  "tenant-exports": { fate: "global", why: "Delete-time customer-data exports (migration 321), removed after 30 days." },
};

const tables = Object.entries(TENANT_TABLES);
const buckets = Object.entries(TENANT_BUCKETS);

/** Kept on purpose: tenant_purge's keep list, and what the report counts as `retained`. */
export const RETAINED_TABLES: readonly string[] = tables.filter(([, t]) => t.fate === "retain").map(([n]) => n);

/** Every other tenant table. Counted again after the purge, so anything that survived it (nothing
 *  should) is reported as `leftBehind` instead of assumed gone. */
export const COUNTED_AFTER_DELETE: readonly string[] = tables.filter(([, t]) => t.fate !== "retain").map(([n]) => n);

/** The customer data written to the export before the purge, in this order, with the columns
 *  that never leave. */
export const EXPORT_TABLES: readonly { table: string; drop: readonly string[] }[] = tables
  .filter(([, t]) => t.export)
  .map(([n, t]) => ({ table: n, drop: t.exportDrop ?? [] }));

/** Swept recursively under <clientId>/ after the purge. */
export const SWEPT_BUCKETS: readonly string[] = buckets.filter(([, b]) => b.fate === "wipe").map(([n]) => n);

/** Customer files put in the export before the sweep. */
export const EXPORTED_BUCKETS: readonly string[] = buckets.filter(([, b]) => b.export).map(([n]) => n);

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
