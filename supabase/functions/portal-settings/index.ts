import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";
import { resolveTenant } from "../_shared/resolveTenant.ts";
import { clientIp } from "../_shared/adminGate.ts";
import { withErrorLog, logEdgeError, SS_REFUSAL_HEADER } from "../_shared/logError.ts";
import { getQboConnection, qboFetch, qboOauthReady, QboApiError, QboBroken, QboNotConnected } from "../_shared/qboToken.ts";
import { qboEndpoints } from "../_shared/qboDiscovery.ts";
import { pushQboInvoice } from "../_shared/qboInvoice.ts";
import { chargeTaxCalculation, taxLookupIdem } from "../_shared/taxMeter.ts";
import { deriveLifecycle, LIFECYCLE_LABEL, type StageKind } from "../_shared/inventoryLifecycle.ts";
import { invoiceTypeFor } from "../_shared/invoiceType.ts";
import {
  rsCreateDomain, rsDeleteDomain, rsGetDomain, rsVerifyDomain, rsDomainVerified,
  rsInboundRecords, rsReceivingEnabled, rsInboundReady,
  resendConfigured, ResendApiError, ResendNotConfigured, type RsDomain,
} from "../_shared/resend.ts";
import { sendTenantEmail } from "../_shared/emailSend.ts";
import { isPlaceholderRecipient } from "../_shared/placeholderRecipient.ts";
import { sendTenantSms } from "../_shared/smsSend.ts";
import { changeOrderEmail, estimateEmail, invoiceEmail, testEmail } from "../_shared/emailTemplates.ts";
import { invoiceUrl } from "../_shared/ghlLinks.ts";
import { myQuotesUrl } from "../_shared/customerPortalUrl.ts";
import { amendedInvoiceDocument, amountOwed, deHtml, designTotalCents, orderCentsAfterAck, orderCentsFromSnapshot, subtotalsFromSnapshot, taxFreeze, totalFromSnapshot } from "../_shared/estimateLines.ts";
// push_to_invoice's phone precondition must use the SAME comparison sign_invoice will use to
// decide whether the customer owns the invoice — see that module's duplication ledger.
import { phoneKey } from "../_shared/phoneKey.ts";
// The change-order baseline, shared with submit-estimate so the two design_edit writers
// cannot disagree about it (migration 153). changeOrderDescription comes with it: the money
// line spans the whole baseline-to-now gap, so the words have to as well. Second importer of
// this module — deploy both.
import { agreedBaseline, changeOrderDescription } from "../_shared/changeOrderDiff.ts";
import { addressFrom } from "../_shared/contactAddress.ts";
import { isConfigured as avalaraConfigured, resolveRate, type ResolvedRate } from "../_shared/salesTax.ts";
import {
  agreedTax, carriedTax, carryDecision, chooseDefaultRate, stampTax, TAX_LOCATION_COLUMNS, taxLocationFrom,
  type CarryDecision, type TaxLocation,
} from "../_shared/taxChain.ts";
import { countLookups24h, DAILY_TAX_LOOKUP_CAP } from "../_shared/taxLookups.ts";
import {
  COMMON_CODES, headingsView, mergeCodeLists, orderCodes, parseAssignmentsPayload, planAssignments, type PlannedAssignment,
  searchQuery, TAX_CODE_SEARCH_LIMIT, TAX_HEADING_GROUPS, taxCodeView, visibleAssignments,
} from "../_shared/taxCodes.ts";
import {
  isAgreedDesign, isVerifiedTax, LOCATION_TAX_COLUMNS, locationTaxReady, locationTaxView, parseSaveLocationTax,
  parseSetSalesLocation, quoteInCustomerHands, ratePct, RESTAMP_DESIGN_COLUMNS, restampPlan, restampResend,
  restampSendOutcome,
} from "../_shared/locationTax.ts";
// The paid lookup (2026-09-17): verify_tax and send_invoice's informational check. The only
// `allowLookup: true` lives inside paidLookup, so neither caller can skip the cap or the ledger.
import {
  chargeLookup, invoiceTaxCheck, invoiceTaxCheckPlan, type InvoiceTaxCheck, lookupSwitchRefusal, paidLookup,
  parseVerifyTax, quoteSentRefusal, verifiedTax, verifyLookupRefusal, verifyQuoteRefusal,
} from "../_shared/taxSpend.ts";
// Why a guarded acceptance promote matched no row. customer-accept's, shared so push_to_invoice's
// rep attestation answers a re-price that lands mid-promote exactly the way a customer's does.
import { promoteMiss } from "../_shared/acceptTotal.ts";
// The rule both writers of an issued quote follow (restampQuoteTax here, submit-estimate's persist).
import { quotePdfStale } from "../_shared/quoteWriteRace.ts";
import { feeFor, normalizeRules } from "../_shared/deliveryFee.ts";
import { isConfigured as deliveryDistanceConfigured } from "../_shared/deliveryDistance.ts";
import { quoteDelivery } from "../_shared/deliveryQuote.ts";
import { buildQuotePdf } from "../_shared/quotePdf.ts";
import { appendAcceptancePage } from "../_shared/acceptancePdf.ts";
import { FIXED_PATH_PDF_UPLOAD } from "../_shared/documentUpload.ts";
import {
  CLADDING_OPTIONS,
  claddingLabel,
  computePaintLine,
  computeRoofLine,
  norm as attrNorm,
  resolveBuildingContext,
} from "../_shared/attributeLines.ts";
import { sanitizeD3Spec, sanitizePhotoUrls, parseModelSpec, modelReplyText, parseObservedNotes, parseFrameMap, gambrelRoofWarning, porchAgreementWarning, knownDimsNote, flagObservedNotes, parseKnownDims, SPEC_PROMPT, videoShapePrompt, combinedShapePrompt, parseSelfCheckRenders, selfCheckPairs, parseSelfCheck, applySelfCheck } from "../_shared/styleD3.ts";
import { guardDecision, mediaList } from "../_shared/styleSaveGuard.ts";
// The v2 generator's two additions (2026-09-24), on their own line so the long list above can move
// without this one: the walk-around frame cap every frame path shares, and the wings check.
import { WALK_FRAME_MAX, wingsAgreementWarning, wantsV2Prompt } from "../_shared/styleD3.ts";
// A raised foundation's save carry-forward (2026-09-25), on its own line for the same reason.
import { carryForwardFoundation } from "../_shared/styleD3.ts";
import { buildCrmFeed } from "../_shared/crmFeed.ts";
import { hasPaidFeature } from "../_shared/featureCheck.ts";
import { chargeTopup, autoTopupDecision } from "../_shared/walletTopup.ts";
// The multi-round self-check (v2), on its own line so the generation's import above stays untouched.
import { parseSelfCheckRound, selfCheckTotalChanges, selfCheckReverted, selfCheckChangedFields, SELF_CHECK_MAX_ROUNDS } from "../_shared/styleD3.ts";
// The check's rollout gate and its one request builder, and the draft's frame-key check (fix,
// 2026-09-24): the check is gated on `frame` like the draft, and a legacy request is d3ab404's.
import { selfCheckMode, selfCheckRequest, frameKeyWarning } from "../_shared/styleD3.ts";
import { aiDraftCostCents, aiModelFields } from "../_shared/styleD3.ts";
// Consensus drafting (2026-09-25): the v2 draft reads the video three times and combines the reads.
import { runDraftCalls, draftCallCount, readDraftReply, consensusOfCalls, draftCallsUsage, consensusSplitWarning, DRAFT_CONSENSUS_GRACE_MS } from "../_shared/styleD3.ts";
// The streamed draft (2026-09-25): a v2 draft answers behind a heartbeat so it can outlive the
// gateway's 150 s of silence (see draftAnswer below).
import { wantsStreamedDraft, DRAFT_STREAM_DEADLINE_MS } from "../_shared/styleD3.ts";
import { heartbeatJsonResponse } from "../_shared/heartbeatJson.ts";
// Draft recovery (2026-09-25): a streamed draft whose connection dropped is read back off its ledger row,
// found by the press's own idempotency key (253).
import {
  draftMoneyState, isRecoverableDraft, pickRecoverRow, recoverDraftAnswer, DRAFT_RECOVER_COLUMNS, DRAFT_RECOVER_MAX_ROWS,
  DRAFT_RECOVER_MONEY_COLUMNS, type DraftMoney, type DraftRecoverMoneyRow, type DraftRecoverRow,
} from "../_shared/styleD3.ts";
// The press's idempotency key, cut one way for the ledger row, the wallet hold and the pickup (253).
import { draftIdemKey } from "../_shared/styleD3.ts";

// ownContactsOnly is the ONE place the literal 'own' is compared for the contacts area. The
// filters it drives are below, in the handler — RLS cannot do this job here, because every
// client this function builds is the SERVICE ROLE and the service role is BYPASSRLS.
import { ownContactsOnly, type GateTable } from "../_shared/access.ts";
import { isQboLineKind } from "../_shared/qboLineKinds.ts";

// WHAT EACH ACTION REQUIRES (migration 100). resolveTenant checks this BEFORE dispatch and
// refuses anything absent, so adding a branch without adding a line here 403s on the first
// call rather than shipping open to every signed-in employee. See _shared/access.ts for why
// this is a table and not a check inside each of the 51 branches below.
//
// This replaces the old READ_ACTIONS / SELF_ACTIONS / STAFF_ACTIONS sets entirely.
const GATES: GateTable = {
  // ── Bootstrap ────────────────────────────────────────────────────────────
  // `status` is the portal's FIRST call and the default action: it carries clientId, role,
  // operatorMode and the business identity the shell renders around every tab. Gating it on
  // settings_crm would lock a driver out of the whole application rather than out of the CRM
  // card, so it stays open and the CRM/QuickBooks fields inside it are filtered per-area at
  // the branch instead (search: STATUS FIELD FILTER).
  status: "open",
  // "self": a write, but only ever to the caller's OWN client_users row. The handler keys
  // strictly off ctx.userId and never off anything in the body -- this gate cannot enforce
  // that, as its own definition in access.ts says. Someone's default view is not tenant
  // data, so a sales rep sets their own.
  save_prefs: "self",

  // ── Your own account ─────────────────────────────────────────────────────
  get_profile: "self",
  save_profile: "self",

  // ── Structures ───────────────────────────────────────────────────────────
  // `catalog` is one payload serving both Settings groups (styles+sizes+prices AND
  // colors/layout/fixtures), and portal.html loads it from five different cards. `any` so a
  // person holding only one of the two still gets their own screen; splitting the payload
  // is the cleaner fix and belongs with the Team screen, not here.
  catalog: { any: [{ area: "settings_structures", level: "view" }, { area: "settings_options", level: "view" }] },
  import_pricing_csv:        { area: "settings_structures", level: "edit" },

  // ── Real-Time Pricing (migration 152) ────────────────────────────────────
  // Same area as the price book they feed: whoever may edit structures may edit the
  // material-cost engine that writes structure prices. Every branch ALSO checks the
  // on_demand_pricing entitlement server-side (hasPaidFeature) — these gates answer
  // "may this person touch settings", the entitlement answers "did this tenant buy it".
  rtp_data:                  { area: "settings_structures", level: "view" },
  save_rtp_material:         { area: "settings_structures", level: "edit" },
  delete_rtp_material:       { area: "settings_structures", level: "edit" },
  reorder_rtp_materials:     { area: "settings_structures", level: "edit" },
  save_rtp_bom:              { area: "settings_structures", level: "edit" },
  save_rtp_overhead:         { area: "settings_structures", level: "edit" },
  import_rtp_workbook:       { area: "settings_structures", level: "edit" },
  set_rtp_enabled:           { area: "settings_structures", level: "edit" },
  create_style:              { area: "settings_structures", level: "edit" },
  update_style:              { area: "settings_structures", level: "edit" },
  delete_style:              { area: "settings_structures", level: "edit" },
  reorder_styles:            { area: "settings_structures", level: "edit" },
  set_style_active:          { area: "settings_structures", level: "edit" },
  set_style_estimate_image:  { area: "settings_structures", level: "edit" },
  set_style_taxable:         { area: "settings_structures", level: "edit" },

  // ── Per-style 3D appearance (the `d3` spec, photos and phone-scan model) ──
  // Grafted from beta-2.0 in the 3D merge. These write `building_styles.d3` /
  // `.d3_photos` / `model_*`, which `get_config` emits to every ANON browser, so they are
  // structure edits and gate exactly like every other style writer above. They arrived
  // with no GATES lines at all: the dispatcher fails closed, so they would have 403'd on
  // a real builder rather than shipping open -- and preflight's cross-check is what named
  // them here instead of letting that surface as "the 3D calibration button is broken".
  save_style_d3:             { area: "settings_structures", level: "edit" },
  calibrate_style_ai:        { area: "settings_structures", level: "edit" },
  // The FREE second pass over a generation this same person just paid for. Same area and the
  // same level on purpose: it reads one of their own ledger rows and hands back a corrected
  // shape for the style they are editing, so anyone who may not edit structures has no business
  // here either. Free does not mean ungated.
  calibrate_style_check:     { area: "settings_structures", level: "edit" },
  // Reads back the draft of a STREAMED generation whose answer never reached the browser (the
  // connection dropped). The generation's own gate, exactly: it hands back what that action would
  // have, for the caller's own row, and nobody who may not generate may read a draft either.
  calibrate_style_ai_recover: { area: "settings_structures", level: "edit" },
  upload_style_photo:        { area: "settings_structures", level: "edit" },
  style_photo_upload_url:    { area: "settings_structures", level: "edit" },
  save_style_media:          { area: "settings_structures", level: "edit" },
  save_style_model:          { area: "settings_structures", level: "edit" },
  set_style_model_status:    { area: "settings_structures", level: "edit" },
  style_model_url:           { area: "settings_structures", level: "edit" },

  // ── Options & colours ────────────────────────────────────────────────────
  save_colors:                    { area: "settings_options", level: "edit" },
  save_window_colors:             { area: "settings_options", level: "edit" },
  save_layout_pricing:            { area: "settings_options", level: "edit" },
  save_wall_heights:              { area: "settings_options", level: "edit" },
  save_cladding:                  { area: "settings_options", level: "edit" },
  save_insulation:                { area: "settings_options", level: "edit" },
  save_electrical:                { area: "settings_options", level: "edit" },
  save_electrical_items:          { area: "settings_options", level: "edit" },
  upload_layout_image:            { area: "settings_options", level: "edit" },
  upload_fixture_image:           { area: "settings_options", level: "edit" },
  save_fixture:                   { area: "settings_options", level: "edit" },
  delete_fixture:                 { area: "settings_options", level: "edit" },
  reorder_fixtures:               { area: "settings_options", level: "edit" },
  import_fixtures:                { area: "settings_options", level: "edit" },
  set_layout_item_archived:       { area: "settings_options", level: "edit" },
  set_layout_item_internal_only:  { area: "settings_options", level: "edit" },
  set_layout_item_taxable:        { area: "settings_options", level: "edit" },
  save_ramp_settings:             { area: "settings_options", level: "edit" },
  // ── Services (233–239): Delivery and Foundation, under the same Options area ──
  // `delivery_test_address` reads like a read and IS one: it prices an address the builder
  // typed against their own rules and may call Google, but writes nothing but a cache row.
  delivery_settings:              { area: "settings_options", level: "view" },
  save_delivery_settings:         { area: "settings_options", level: "edit" },
  delivery_test_address:          { area: "settings_options", level: "view" },
  save_foundation:                { area: "settings_options", level: "edit" },
  // (save_doors / save_ramps / save_windows were here until 2026-08-07. They were legacy
  // full-replace writers with no caller anywhere, each of which DELETED every fixture_items
  // row of its category absent from the payload — so the endpoints, and these gates with
  // them, were removed rather than left gated. Deleting a live endpoint means deleting its
  // gate: the preflight cross-checks this table against the branches below.)

  // ── Branding, business details, lots ─────────────────────────────────────
  // `save` writes CRM credentials AND business identity/quote terms in one call, so it
  // requires both. Conservative on purpose: today every title holding one holds the other,
  // and the alternative (pick one area, write both) would let half the form through a gate
  // that names the other half.
  save: { all: [{ area: "settings_crm", level: "edit" }, { area: "settings_branding", level: "edit" }] },
  save_branding: { area: "settings_branding", level: "edit" },
  upload_logo:   { area: "settings_branding", level: "edit" },
  save_location:   { area: "settings_branding", level: "edit" },
  delete_location: { area: "settings_branding", level: "edit" },
  // The lot list is a Settings card AND the Inventory tab's location picker — two
  // populations, neither of which covers the other.
  list_locations: { any: [{ area: "settings_branding", level: "view" }, { area: "inventory", level: "view" }] },
  // The serial counter is shared by Inventory and Orders but is configured from a Settings
  // card; branding is where that card lives, and it is an owner/admin-shaped decision.
  save_serial_start: { area: "settings_branding", level: "edit" },

  // ── CRM ──────────────────────────────────────────────────────────────────
  verify_save_ghl:     { area: "settings_crm", level: "edit" },
  list_ghl_pipelines:  { area: "settings_crm", level: "view" },

  // ── Sales tax (migrations 244-245) ───────────────────────────────────────
  // The SAME area as the company rate (ss_tax_rate is saved through `save`, on this card's
  // area), so whoever may set the company rate sets the per-location ones — and nobody else:
  // not settings_branding, which owns the lot list and is granted so somebody can change a
  // logo. No new area: a new one needs the SQL mirror (area_level_for) re-issued with it.
  tax_settings:      { area: "settings_crm", level: "view" },
  save_location_tax: { area: "settings_crm", level: "edit" },
  // Which lot a quote was sold from. designs:edit — the rep who issues the quote picks where it
  // was sold, the way set_expected_close works — plus the row scope in the branch. It re-prices
  // with FREE rates only (the location's, else the company's); it can never make a paid lookup.
  set_design_sales_location: { area: "designs", level: "edit" },
  // The Verify button: a PAID Avalara lookup for one quote's delivery address. settings_crm, the
  // company rate's area, NOT designs:edit — every Sales Rep holds designs:edit, and today no rep
  // can spend a cent; a button that bills the builder's allowance belongs to whoever may set the
  // builder's tax rates. The branch adds the row scope (refuseUnlessDesignVisible) on top.
  verify_tax:        { area: "settings_crm", level: "edit" },
  // Tax codes (migration 246): the Avalara code on each building style and option heading
  // (Settings → Company → Tax). The same area as the rates, for the same reason, and no new area.
  // Saved only — no quote reads the mapping yet. The search reads the platform catalog, never
  // Avalara, so it spends nothing.
  tax_codes_get:     { area: "settings_crm", level: "view" },
  tax_codes_search:  { area: "settings_crm", level: "view" },
  tax_codes_save:    { area: "settings_crm", level: "edit" },

  // ── QuickBooks ───────────────────────────────────────────────────────────
  // Same two-question split as Real-Time Pricing above: these gates answer "may this person
  // touch the QuickBooks settings", and a server-side entitlement check (quickbooks_sync,
  // PAY-ONLY) answers "did this tenant buy it" — see the QBO_ACTIONS block below.
  // `disconnect_qbo` is deliberately outside that entitlement check: revoking our access to
  // someone's books must never depend on their subscription being current.
  qbo_status:      { area: "settings_quickbooks", level: "view" },
  qbo_pending:     { area: "settings_quickbooks", level: "view" },
  list_item_map:   { area: "settings_quickbooks", level: "view" },
  list_qbo_items:  { area: "settings_quickbooks", level: "view" },
  save_item_map:   { area: "settings_quickbooks", level: "edit" },
  // `qbo_test` reads like a read — it is a "Test connection" button — but it writes
  // qbo_company_name and can drive a token refresh. Gated as the write it is.
  qbo_test:        { area: "settings_quickbooks", level: "edit" },
  disconnect_qbo:  { area: "settings_quickbooks", level: "edit" },
  retry_qbo_push:  { area: "settings_quickbooks", level: "edit" },

  // ── Email sending (Settings → Email Sending) ─────────────────────────────
  // Own-domain estimate/invoice email (Resend-backed). The area is admin-preset only
  // (deny-by-default for every staff title — intended: connecting a domain changes what
  // every customer-facing email looks like).
  email_status:         { area: "settings_email", level: "view" },
  email_connect_domain: { area: "settings_email", level: "edit" },
  email_save_template: { area: "settings_email", level: "edit" },
  email_verify_domain:  { area: "settings_email", level: "edit" },
  email_activate:       { area: "settings_email", level: "edit" },
  email_send_test:      { area: "settings_email", level: "edit" },
  email_disconnect:     { area: "settings_email", level: "edit" },
  // Receiving replies on reply.<domain>. Same area as sending: the two halves are one
  // decision to a builder, and splitting the permission would let someone redirect where a
  // customer's replies land without being trusted to change how mail goes out.
  email_inbound_connect:    { area: "settings_email", level: "edit" },
  email_inbound_verify:     { area: "settings_email", level: "edit" },
  email_inbound_disconnect: { area: "settings_email", level: "edit" },

  // ── Workspace ────────────────────────────────────────────────────────────
  contact_activity: { area: "contacts", level: "view" },

  // ── CRM record page (the merged Contacts + Designs view) ─────────────────
  // `any:` because one page serves both a contact and a design, and a rep who can see
  // designs but not contacts should still reach a design record. Mirrors `catalog`'s shape.
  //
  // ⚠️ `any:` IS NOT THE WHOLE ANSWER FOR THESE TWO, and it cannot be. One action serves two
  // scopes with different owners: the DESIGN half belongs to `designs`, the CONTACT half
  // (the person's record, their notes, their email and text threads, the files they sent)
  // belongs to `contacts`. A table entry can only ask one question per action, and `any`
  // asks the looser one — so a designs-only title (the Crew Leader preset) satisfied it and
  // then received the contact half as well. The per-scope check therefore lives in the
  // branch, right where the contact rows are read: search CONTACT SCOPE below. The gate
  // stays `any` so the design record still opens for exactly the people it always did.
  crm_record:            { any: [{ area: "contacts", level: "view" }, { area: "designs", level: "view" }] },
  crm_feed:              { any: [{ area: "contacts", level: "view" }, { area: "designs", level: "view" }] },
  crm_send_email:        { area: "contacts", level: "edit" },
  crm_save_note:         { area: "contacts", level: "edit" },
  crm_delete_note:       { area: "contacts", level: "edit" },
  crm_save_activity:     { area: "contacts", level: "edit" },
  crm_complete_activity: { area: "contacts", level: "edit" },
  crm_save_contact:      { area: "contacts", level: "edit" },
  crm_send_sms:          { area: "contacts", level: "edit" },
  // Recording that a customer gave permission is a claim about them, so it sits at the
  // same level as texting them — the people who talk to customers, not everyone.
  crm_record_consent:    { area: "contacts", level: "edit" },
  // Customer Uploads (migration 151). Signing an upload and deleting a file are writes;
  // the READ rides crm_record, which is already gated above.
  crm_file_sign:         { area: "contacts", level: "edit" },
  crm_file_attach:       { area: "contacts", level: "edit" },
  crm_file_delete:       { area: "contacts", level: "edit" },
  // ⚠️ THE AREA IS THE FLOOR HERE, NOT THE WHOLE RULE — role is, and this is the one action
  // in this table where that is true, so it is said out loud rather than left to be
  // discovered. Deleting a design destroys the customer's version history and the estimate
  // in the tenant's CRM with it, and it has been owner/admin ever since it shipped: the
  // browser hides the menu item on `isAdmin`, and under the pre-migration-100 model the
  // resolver refused every non-owner/admin mutation, so the server agreed. Expressing it as
  // `designs:edit` alone widened it — that level is a Sales Rep's preset — while the screen
  // went on saying owner/admin only. Restated as a role check inside the branch (search
  // OWNER/ADMIN ONLY) rather than as a second area, because no area names "may destroy a
  // customer record" and `delete_inventory`'s trick (a second area only owners/admins hold)
  // would be a coincidence of today's presets rather than the rule itself.
  delete_design:    { area: "designs", level: "edit" },
  // NOT inventory:edit. A sales rep's preset is inventory:'view', and this only tags a
  // design they just created with the unit it was quoted from — gating it on inventory:edit
  // recreates the 2026-08-02 bug exactly (estimate sent, link 403s, the building never
  // shows the estimate and never flips to Sold).
  link_design_to_unit: { area: "designs", level: "edit" },
  // The pipeline board's expected close date (migration 206). designs:edit — the same area
  // that gates every other write to a design, and one a Sales Rep holds, because setting a
  // close date on your own quote is the whole point of the field.
  set_expected_close: { area: "designs", level: "edit" },
  list_inventory:   { area: "inventory", level: "view" },
  save_inventory:   { area: "inventory", level: "edit" },
  update_inventory: { area: "inventory", level: "edit" },
  // The four verbs migration 102 split out of update_inventory's old `status` field. Each is
  // gated on the AREA, never on role === 'owner'|'admin': a hard-coded role check alongside a
  // gate is a contradiction (see resolveTenant's note) — a granted title would pass the table
  // and then be refused anyway, which defeats per-person access. inventory:'edit' is
  // owner/admin by preset today; every read-only title has 'view'.
  // Releasing a wrongly-sold building. There is deliberately no sell_inventory to match it:
  // a sale is a consequence of an invoice or a payment, never a button (Carolyn 2026-08-08).
  // See claimUnitSale below for the three places a sale is actually recorded.
  unsell_inventory: { area: "inventory", level: "edit" },
  // Deleting a unit also deletes its design row, that design's versions and its PDFs. That
  // is a Designs deletion happening under an Inventory verb, so it needs both.
  delete_inventory: { all: [{ area: "inventory", level: "edit" }, { area: "designs", level: "edit" }] },
  // Emails a real customer and moves the design to invoiced — irreversible, so Orders:edit.
  send_invoice:     { area: "orders", level: "edit" },
  // Push to Invoice from the designer (Carolyn 2026-09-01): the same irreversible send as
  // send_invoice, and additionally it ATTESTS the acceptance on the customer's behalf. It
  // can only ever be more consequential than send_invoice, never less, so it sits at the
  // same gate — deliberately its own row rather than a flag on send_invoice, so this
  // altitude is stated once per action and cannot be reached by a body parameter.
  push_to_invoice:  { area: "orders", level: "edit" },
  // "Not now" on an invoice request (migration 229): the builder sets aside, for the moment,
  // the draft invoice a customer's Accept raised. The other half of send_invoice — which is
  // what APPROVING a request is — so it sits on the same gate: whoever may issue the invoice
  // may decide not to yet. It issues, voids and emails nothing, and sending the invoice later
  // still works (and marks the same request approved).
  dismiss_invoice_request: { area: "orders", level: "edit" },
  // Re-sends the SS quote email (migration 122) — the rep who can edit designs can re-send
  // the quote for one. Idempotent (no numbering, no conversion): worst case is a duplicate
  // email to the design's own customer.
  resend_quote_email: { area: "designs", level: "edit" },
  // Texts the customer the deep link to sign their invoice. Sends no money and creates no
  // paperwork — it re-delivers a document they already have — but it does spend the
  // tenant's A2P campaign, so it sits at the same altitude as sending the invoice itself.
  // A rep who may raise a change may also hand the customer the phone to sign it. Widened
  // 2026-09-07: a signature on an AMENDED order goes through this same link, and gating it on
  // orders:'edit' alone would have let someone open a change they could not then get signed.
  text_sign_link:   { any: [{ area: "orders", level: "edit" }, { area: "change_orders", level: "edit" }] },
  // Rebuild the invoice DOCUMENT from the current amended figures (migration 221). Issuing
  // paperwork is `orders`, the same area send_invoice sits on -- this reissues a document,
  // it does not decide whether a change may happen.
  reissue_invoice:  { area: "orders", level: "edit" },
  // Emails a pending change order to the customer for signature (migration 126).
  // Moved off `orders` onto `change_orders` (2026-09-01) when reps gained orders:edit —
  // amending a signed agreement is the one order power that is granted separately.
  send_change_order: { area: "change_orders", level: "edit" },
  // The invoice-style order document (migration 127): letterhead + color options + the
  // service-role-only invoice_sends fields. A read.
  order_paperwork: { area: "orders", level: "view" },
  // The designs behind the orders on screen. Exists because the Orders tab shipped to
  // TENANTS (2026-09-01) and its designs read had been direct-RLS — see the action below.
  orders_designs: { area: "orders", level: "view" },
  // Changing roof/cladding/paint on an order — reprices from the catalog and raises the
  // change order. It reads like ordinary editing and is not: on a signed order these
  // dropdowns ARE how a change order gets raised, so it sits with the others.
  stage_order_attribute_change: { area: "change_orders", level: "edit" },
  // Discards a staged-but-unsigned change order, restoring the design as the customer
  // signed it (snapshot_before). Void with a reason, like the browser void.
  void_change_order: { area: "change_orders", level: "edit" },

  // AMENDING A SIGNED ORDER (migrations 209-213).
  // What the Change Order button has to know BEFORE it does anything: is this order open
  // for change, under what authority, and what will it cost. A read, so it sits at `view`
  // -- a rep who cannot raise one may still be shown why. This is the first consumer of
  // change_orders:'view'; before it, the area had no read surface at all.
  amendment_status: { area: "change_orders", level: "view" },
  // The rep asks. Raising the request is part of raising the change.
  request_order_unlock: { area: "change_orders", level: "edit" },
  // The approver answers. THE ONLY ACTION ON THE NEW AREA -- this is the whole of what
  // "Approve Changes" grants, which is why it is a separate switch from raising one.
  decide_order_unlock: { area: "change_order_approve", level: "edit" },
  // Spends the unlock and opens the draft the rep then edits.
  open_amendment: { area: "change_orders", level: "edit" },
  // Prices the finished edit, writes the words from the line diff, and sends it. The rep is
  // still the one raising the change -- the customer's answer is what comes next.
  finalize_amendment: { area: "change_orders", level: "edit" },
  // The rep records that the customer said yes, in the rep's own name. Deliberately NOT on
  // the approve area: attesting is part of raising a change, not part of allowing one, and
  // Carolyn asked for those to be separate switches.
  attest_change_order: { area: "change_orders", level: "edit" },
};

// Owner-facing settings endpoint for the portal (portal.html).
//
// Auth model: the gateway's verify_jwt only proves the caller holds *a* valid JWT —
// the public anon key passes that check too. So this function additionally resolves
// a real signed-in user via auth.getUser(), then maps user → client through the
// client_users table (service role). The client_id is NEVER taken from the request
// body; an owner can only ever read/write their own tenant's settings.
//
// Actions:
//   { action: "status" } → current settings, with the GHL API key reduced to a
//     hasApiKey boolean and the location id masked. Secrets never leave the server.
//   { action: "save", ...fields } → partial upsert of client_settings. Only fields
//     present in the body are written; an absent or empty ghlApiKey never blanks a
//     stored key (the form's password field submits empty when untouched).

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...cors, "Content-Type": "application/json" },
  });
}

// 5xx responses whose app_errors row was already written at the return site, with more detail
// than the wrapper can see (withErrorLog's `alreadyFiled` option skips them). Only the AI draft
// failures in calibrate_style_ai use it: each one logs its own coded row carrying the reply's
// shape, and the wrapper's generic copy of the same failure added a third row per press that
// said nothing new. Faults still land as `error`; this removes a duplicate, not a record.
// A WeakSet, so a response that has been answered is not held onto.
const filedAtReturnSite = new WeakSet<Response>();

// ── THE STREAMED DRAFT (2026-09-25) ──────────────────────────────────────────────────────────
// How calibrate_style_ai answers: the branch's own Response, or the same answer behind a heartbeat.
//
// WHY. The gateway ends a request that has sent nothing for 150 s (a bare 504, invisible to
// withErrorLog), so the draft's model abort has had to stop at 125 s. At effort "medium", Opus
// often answered a walk-around in 10-15 s with ~480 output tokens, and those shallow reads were
// wrong on the hard calls (a shed's high side on the wrong wall 6 times in 7); the reads that
// thought (3,400-5,400 tokens) took 56-106 s and were right. At "high" all three consensus reads
// ran past 125 s. The gateway times SILENCE, not the request (a probe that wrote a space every 10 s
// answered 200 after 220 s), so a streamed draft can take the time a careful read needs.
//
// WHICH REQUESTS: wantsStreamedDraft (styleD3.ts), i.e. `stream: true` from the new shell, the v2
// prompt, and not the lean retry. EVERY OTHER REQUEST gets `work(false)`, the branch's own
// Response, unchanged: production's older shell, the lean retry and every legacy request.
//
// A streamed request answers 200 at once (heartbeatJson.ts) and runs the SAME branch behind it,
// with `streamed` true: the only things that differ are the model's budget and effort, read inside
// the branch. Every exit keeps its order and its hold release, ledger write, capture and log rows;
// a failure's status rides in the body instead of the status line.
//
// ⚠️ THE ERROR WRAPPER CANNOT SEE THROUGH THE 200. Unstreamed, withErrorLog files a row for an
// uncoded 5xx exit ("Could not reach the AI service", the meter's 503s) and for a throw; streamed,
// it only ever sees a 200 and would file neither. So the work runs inside a REPLAY of the wrapper,
// on a request carrying the three things the wrapper reads (the URL, the user agent, and the body,
// for its client id), which files exactly the rows the unstreamed answer would have: the same
// `alreadyFiled` rule, the same message, the same severity. The replay rethrows a throw, and the
// heartbeat answers it as a 500.
//
// THE WATCHDOG (2026-09-25). supabase-js has no timeout, so a streamed draft that hangs after its
// reads (a database call that never returns) would keep writing spaces until the platform killed the
// worker, and the browser would read a body cut off mid-space. The answer is closed at
// DRAFT_STREAM_DEADLINE_MS from the request's arrival instead, with heartbeatJson's `stream_deadline`
// body (a 504, not retryable), and one coded row is filed. The work is NOT stopped: it stays
// registered with EdgeRuntime.waitUntil, releases or captures its hold and writes its ledger row, and
// the browser picks the draft up from that row (calibrate_style_ai_recover).
function draftAnswer(
  req: Request,
  payload: unknown,
  at: { requestStartMs: number; clientId: string },
  work: (streamed: boolean) => Promise<Response>,
): Promise<Response> | Response {
  if (!wantsStreamedDraft(payload)) return work(false);
  const ua = req.headers.get("user-agent");
  const replay = new Request(req.url, { method: "POST", headers: ua ? { "user-agent": ua } : {}, body: JSON.stringify(payload) });
  const filed = withErrorLog("portal-settings", () => work(true), { alreadyFiled: (res) => filedAtReturnSite.has(res) });
  return heartbeatJsonResponse(() => filed(replay), {
    headers: { ...cors, "Content-Type": "application/json" },
    deadlineMs: DRAFT_STREAM_DEADLINE_MS - (Date.now() - at.requestStartMs),
    onDeadline: () => logEdgeError({
      fn: "portal-settings", req, clientId: at.clientId, code: "ai_draft_stream_deadline",
      message: "The streamed draft's answer reached its deadline with the work still running; it was closed with stream_deadline and the work ran on.",
      context: { requestMs: Date.now() - at.requestStartMs, deadlineMs: DRAFT_STREAM_DEADLINE_MS },
    }),
  });
}

/**
 * A database or storage call failed. Log the real reason server-side; tell the caller
 * something they can act on.
 *
 * WHY (2026-08-07): ~40 handlers returned PostgREST's `error.message` verbatim, which is
 * written for whoever wrote the schema — "null value in column \"label\" of relation
 * \"colors\" violates not-null constraint" names tables, columns and constraints, and it
 * lands on a builder's settings screen where none of that is actionable. It is also not
 * ours to publish: the wording changes with the Postgres version.
 *
 * This is NOT a return to swallowing errors — the failure c38b5aa fixed. That change was
 * about the portal hiding the reasons THIS FUNCTION writes behind supabase-js's generic
 * "non-2xx", and every one of those authored messages ("Not signed in.", "invalid width",
 * "That user is not in this account.") still reaches the browser untouched. What changes
 * here is only the text we did not write. Nothing is lost either: the raw message goes to
 * `app_errors` with the same `where` label the caller is shown, so a support question
 * ("it says it couldn't save my colors") maps to one row.
 *
 * `where` completes "Couldn't …" and is the correlation key — keep it short, specific and
 * stable, because it is both user-facing text and the thing you grep app_errors for.
 */
function dbFail(
  req: Request,
  clientId: string | null,
  where: string,
  // deno-lint-ignore no-explicit-any
  err: any,
  status = 500,
) {
  logEdgeError({
    fn: "portal-settings",
    req,
    clientId,
    code: err?.code ?? status,
    message: `${where}: ${err?.message ?? "unknown database error"}`,
    context: { where, pgCode: err?.code ?? null, details: err?.details ?? null, hint: err?.hint ?? null },
  }).catch(() => {});
  return json({
    error: `Couldn't ${where}. Please try again — if it keeps happening, tell CSM Synergy and mention "${where}".`,
    ref: where,
  }, status);
}

function maskId(v: string | null): string | null {
  if (!v) return null;
  return v.length > 8 ? v.slice(0, 4) + "…" + v.slice(-4) : v.slice(0, 2) + "…";
}

// ── Email sending helpers ───────────────────────────────────────────────────────
// The Settings → Email DNS table's rows, snapshotted onto client_settings.email_dns_records
// so email_status can render without a Resend round trip. Shape is the EmailSendingView
// contract: [{type, host, value, verified}] plus an optional MX priority. Resend's set is DKIM TXT + SPF TXT + SPF MX.
type DnsRow = { type: string; host: string; value: string; verified: boolean; priority?: number };
function dnsRecordsOf(d: RsDomain): DnsRow[] {
  // Resend returns a VARIABLE list (today: DKIM TXT + SPF TXT + SPF MX), not a fixed pair,
  // so this maps rather than hand-builds. resend.ts already normalised the shape.
  //
  // USE r.fqdn, NEVER r.host: Resend's name is relative to the ZONE APEX ("send.mail"), so a
  // UI rendering it verbatim hands the tenant a record that lands at the wrong node.
  //
  // priority is carried because an MX WITHOUT one cannot be created — dropping it would hand
  // the tenant a record their DNS panel refuses.
  return d.records
    .map((r) => ({
      type: r.type,
      host: r.fqdn,
      value: r.value,
      verified: r.verified,
      ...(r.priority != null ? { priority: r.priority } : {}),
    }))
    // A row with no host is a shape we can't render or copy — drop it rather than showing
    // an empty record a tenant would dutifully paste into their DNS.
    .filter((r) => r.host && r.value);
}

/**
 * A Resend call failed. Two authored outcomes, never a 500 and never provider text:
 *   - ResendNotConfigured is the platform-not-ready state, not an incident — the tenant
 *     gets the same friendly sentence the platformReady:false card shows.
 *   - ResendApiError carries only enum-ish fields by construction (resend.ts strips
 *     the provider Message because it can echo recipient addresses). The status/errorCode
 *     go to app_errors under the same `where` label the caller is shown — dbFail's
 *     correlation posture applied to a third-party API.
 */
function rsFail(req: Request, clientId: string | null, where: string, e: unknown) {
  if (e instanceof ResendNotConfigured) {
    return json({ error: "Email sending isn't available yet — it's still being set up. Please try again later." }, 503);
  }
  const detail = e instanceof ResendApiError
    ? `resend ${e.status}/${e.name_ || "unknown"}${e.permanent ? " permanent" : ""}`
    : String((e as Error)?.message ?? e ?? "unknown error").slice(0, 300);
  logEdgeError({
    fn: "portal-settings",
    req,
    clientId,
    code: e instanceof ResendApiError ? e.status || 502 : 502,
    message: `${where}: ${detail}`,
    context: { where, resendErrorName: e instanceof ResendApiError ? e.name_ : null },
  }).catch(() => {});
  return json({
    error: `Couldn't ${where}. Please try again — if it keeps happening, tell CSM Synergy and mention "${where}".`,
    ref: where,
  }, 502);
}

// Upper bound on any caller-supplied bulk array. Not a business limit — it is far above
// the largest real catalog (the biggest tenant runs ~424 sizes) — but these actions loop
// per element issuing DB round trips, and several DELETE whatever is absent from the list,
// so an unbounded array is both a long-running request and a large blast radius. Only
// import_fixtures (500) had a cap before; the rest took whatever arrived.
const MAX_BULK_ROWS = 2000;
const tooMany = (arr: unknown[], what: string): string | null =>
  arr.length > MAX_BULK_ROWS ? `Too many ${what} in one request (${arr.length}; limit ${MAX_BULK_ROWS}). Split it into smaller batches.` : null;

// Deliberately permissive — an "obviously not an address" check, not an RFC 5322 parser.
// Kept byte-identical to submit-estimate's copy on purpose: this one refuses to STORE a
// beta_email that one would refuse to SEND to, so a divergence would let a tenant save a
// value that then blocks every submission. Change both or neither.
const isEmail = (v: string): boolean => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v);

// Rebuild the SS quote PDF from a (patched or restored) estimate_lines snapshot and upsert
// it over the SAME storage path, so every link the customer holds keeps working — then
// RE-APPEND the acceptance certificate page when the quote was signed (migration 124).
// Regeneration must never silently drop the countersign: the design_acceptances row and the
// signatures-bucket PNG remain the legal record, and the visible document re-earns its
// certificate every time it is rebuilt. Best-effort by contract (quotePdf.ts): a PDF
// problem logs and returns null; it never blocks the change that triggered it.
// deno-lint-ignore no-explicit-any
/** The three order money columns from a snapshot (migration 148), written TOGETHER so
 *  pretax + tax = total by construction. `fallbackTotal` covers a snapshot too old to price —
 *  it keeps today's behaviour of writing the total on its own. Column names are spelled out
 *  here rather than spread from orderCentsFromSnapshot, whose keys are camelCase. */
// deno-lint-ignore no-explicit-any
function orderMoneyCols(snap: any, fallbackTotal: number | null): Record<string, unknown> {
  const m = orderCentsFromSnapshot(snap);
  if (!m) return fallbackTotal == null ? {} : { total_cents: Math.round(fallbackTotal * 100) };
  return { total_cents: m.totalCents, pretax_subtotal_cents: m.pretaxCents, tax_cents: m.taxCents };
}

async function regenerateQuotePdf(
  admin: any,
  req: Request,
  clientId: string,
  shortCode: string,
  input: { quoteNumber: string; snap: any; planUrl: unknown },
): Promise<string | null> {
  try {
    const { data: cs } = await admin.from("client_settings")
      .select("business_name, business_phone, business_website, business_address, quote_terms")
      .eq("client_id", clientId).maybeSingle();
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const expectedPdfPrefix = `${supabaseUrl}/storage/v1/object/public/floor-plans/${clientId}/`;
    const planUrl = input.planUrl && String(input.planUrl).startsWith(expectedPdfPrefix) ? String(input.planUrl) : null;
    const lines = Array.isArray(input.snap?.lines) ? input.snap.lines : [];
    let pdfBytes = await buildQuotePdf({
      business: {
        name: String(cs?.business_name ?? "").trim() || clientId,
        phone: cs?.business_phone ?? null,
        website: cs?.business_website ?? null,
        address: cs?.business_address ?? null,
      },
      estimateNumber: input.quoteNumber,
      dateIso: new Date().toISOString(),
      // deno-lint-ignore no-explicit-any
      lines: lines.map((l: any) => ({ ...l, desc: deHtml(String(l?.desc ?? "")) })),
      discount: Number(input.snap?.discount) || 0,
      // The tax the snapshot was STAMPED with, not a fresh lookup (migration 148). A re-render
      // must reproduce the document the customer already has; re-resolving here would let a
      // regenerate silently restate what they were quoted.
      tax: input.snap?.tax ?? null,
      discountRows: input.snap?.discounts?.rows ?? null,
      quoteTerms: cs?.quote_terms ?? null,
      planPdfUrl: planUrl,
    });

    const { data: acc } = await admin.from("design_acceptances")
      .select("method, signer_name, typed_signature, signature_image_path, accepted_at, ip, consent_text, total")
      .eq("client_id", clientId).eq("short_code", shortCode).eq("subject", "quote")
      .maybeSingle();
    // ONLY a real signature earns a certificate page. Since migration 136 a quote is
    // accepted with a CLICK, and `method` would otherwise fall through the ternary below to
    // "typed" and print a certificate asserting a typed signature over an empty name — a
    // document claiming more than the customer actually did. Legacy signed quotes still
    // carry theirs, because the rule reads the stored method rather than a version flag.
    if (acc && (acc.method === "drawn" || acc.method === "typed")) {
      let signaturePng: Uint8Array | null = null;
      if (acc.signature_image_path) {
        try {
          const dl = await admin.storage.from("signatures").download(String(acc.signature_image_path));
          if (dl.data) signaturePng = new Uint8Array(await dl.data.arrayBuffer());
        } catch (_e) { /* the typed fields still countersign */ }
      }
      try {
        pdfBytes = await appendAcceptancePage(pdfBytes, {
          businessName: cs?.business_name ?? null,
          quoteNumber: input.quoteNumber,
          total: acc.total == null ? null : Number(acc.total),
          signerName: String(acc.signer_name ?? ""),
          method: acc.method === "drawn" ? "drawn" : "typed",
          signaturePng,
          typedSignature: acc.typed_signature ?? null,
          acceptedAtIso: String(acc.accepted_at ?? ""),
          ip: acc.ip == null ? null : String(acc.ip),
          consentText: String(acc.consent_text ?? ""),
        });
      } catch (e) {
        console.warn("acceptance page re-append failed:", (e as Error).message);
      }
    }

    const pdfPath = `${clientId}/${shortCode}-quote.pdf`;
    const up = await admin.storage.from("floor-plans")
      .upload(pdfPath, pdfBytes, FIXED_PATH_PDF_UPLOAD);
    if (up.error) { console.warn("quote PDF regenerate upload failed:", up.error.message); return null; }
    const { data: pub } = admin.storage.from("floor-plans").getPublicUrl(pdfPath);
    const url = pub?.publicUrl || null;
    if (url) {
      await admin.from("designs").update({ ss_quote_pdf_url: url })
        .eq("client_id", clientId).eq("short_code", shortCode).is("ss_quote_pdf_url", null);
    }
    return url;
  } catch (e) {
    logEdgeError({ fn: "portal-settings", req, clientId, code: 500, message: `quote PDF regenerate failed: ${(e as Error).message}`, context: { shortCode } }).catch(() => {});
    return null;
  }
}

// Carolyn 2026-08-07: a sold display keeps its SOLD badge on the storefront for 30 days and
// then silently falls off the list. Nothing public exists to hang that on yet, so this only
// feeds a computed expiry on list_inventory today — but it is the ONE place the number lives,
// so the future listing query and this agree by construction.
const SOLD_LABEL_DAYS = 30;

// The buyer's first name, for the "SOLD — Dave" label. Contact names are ONE flat field in
// this product (there is no first/last split anywhere in storage, and contactFields[] cannot
// gain one without breaking the designer's form and its validation), so this is the same
// split submit-estimate already uses to title a GHL estimate. Snapshotted at the sale so the
// label never has to join back to a customer's design row to render.
// deno-lint-ignore no-explicit-any
function firstNameOf(contact: any): string | null {
  const full = String(contact?.name ?? "").trim();
  if (!full) return null;
  return full.split(/\s+/)[0] || null;
}

// ── floor-plans object keys ─────────────────────────────────────────────────────
// delete_design hands object keys to a SERVICE-ROLE remove(), which bypasses storage RLS,
// and the only record of which file belongs to which design is designs/design_versions
// .image_url — a column the anon-callable save_design RPC writes verbatim. So a stored URL
// is untrusted input: it may say WHICH of this design's objects to remove, never WHOSE.
const FLOOR_PLANS = "floor-plans";
const OBJECT_PATH = `/storage/v1/object/public/${FLOOR_PLANS}/`;

// The only tails our uploader has ever produced: none (the pre-2026-06-15 `<code>.pdf`
// shape) or submitQuote's `-${Date.now()}` suffix.
const KEY_TAIL = /^(-[0-9]+)?\.(pdf|png)$/;

// The bucket-root era — slash-less object names, before per-tenant prefixes. It is CLOSED:
// the newest row referencing one was created 2026-06-12, the first prefixed row 2026-06-15,
// and migration 031's storage INSERT policy now requires a "<slug>/" prefix, so no new root
// object can be created. The date therefore records finished history, not policy. Only a
// design row from that era may name a root object; a row with no parseable created_at is
// treated as newer, which is the safe direction.
const LEGACY_ROOT_ERA_END = Date.parse("2026-06-14T00:00:00Z");

/** Object key from a stored public URL, or null if it is not one of our floor-plan URLs. */
function floorPlanKey(u: unknown): string | null {
  if (typeof u !== "string" || !u) return null;
  let path: string;
  try { path = new URL(u.trim()).pathname; } catch { return null; } // not a URL at all
  if (!path.startsWith(OBJECT_PATH)) return null;
  const key = path.slice(OBJECT_PATH.length);
  // Percent-escapes are REJECTED, never decoded: decodeURIComponent throws on a lone "%",
  // withErrorLog would turn that into a 500, and the design would become undeletable.
  // Nothing legitimate needs them — the code alphabet is [A-HJ-NP-Z2-9] and the tail is
  // digits. new URL() has already resolved any "../" and dropped query/fragment.
  // Only the PATH is pinned, deliberately not the host: the key is checked against
  // server-derived values below, so an off-host URL can still only name this design's own
  // object, whereas anchoring on SUPABASE_URL would reject every row under
  // `functions serve` or behind a future storage CDN and silently orphan every file.
  return key && key.length <= 300 && !key.includes("%") ? key : null;
}

/** Could THIS design's own uploads have produced `key`? Both inputs are server-resolved and
 *  neither is ever read from the request body. shortCode comes from the matched row, and
 *  designs.short_code is globally UNIQUE (designs_short_code_key), so it names at most one
 *  design anywhere — that uniqueness IS the authorization test here, not the date gate above.
 *  clientId is the resolved tenant slug: straight from client_users on the ordinary
 *  owner/admin path, assertClient-validated only on the operator-override path. So it is NOT
 *  shape-guaranteed here and must not need to be — plain string ops only, and no RegExp is
 *  ever built from either value, which is what keeps this correct whatever a slug contains. */
function isOwnFloorPlanKey(key: string, clientId: string, shortCode: string, legacyOk: boolean): boolean {
  let name = key;
  if (key.startsWith(`${clientId}/`)) name = key.slice(clientId.length + 1);
  // Another tenant's prefix, or a root object this row is too new to have created.
  else if (key.includes("/") || !legacyOk) return false;
  return name.startsWith(shortCode) && KEY_TAIL.test(name.slice(shortCode.length));
}

// Shared CSV pricing + inclusion importer (mirror of admin-catalog's). rows:
// [{ style, width, length, price, active, inclusions: { item_key: qty } }].
// Inclusion cells are QUANTITIES (2026-07-07): loft = included sq ft (e.g. 50),
// doors = count (e.g. 1); 0/blank/"no" = not included. Legacy yes-style tokens
// still import as quantity 1 so previously downloaded sheets keep working.
// clientId is the JWT-resolved tenant — never trusted from the request body.
// CREATES the size if a (style, width, length) doesn't exist yet, otherwise UPDATES
// it — keyed on dimensions, so re-uploading the same sheet updates prices without
// creating duplicates. A size is offered only when active AND priced (blank price or
// active=no hides it, per the NULL-base-price contract). Never creates styles.
async function importPricingRows(sb: any, clientId: string, rows: any[]) {
  const st = await sb.from("building_styles").select("id, key, label").eq("client_id", clientId);
  if (st.error) throw st.error;
  const sz = await sb.from("building_sizes").select("id, style_id, width_ft, length_ft, sort_order").eq("client_id", clientId);
  if (sz.error) throw sz.error;
  const styleByName = new Map<string, any>();
  for (const s of st.data ?? []) { styleByName.set(String(s.label).toLowerCase(), s); styleByName.set(String(s.key).toLowerCase(), s); }
  const sizeByDims = new Map<string, any>();   // `${style_id}|${w}|${l}` -> row
  const maxSort = new Map<string, number>();   // style_id -> highest sort_order
  for (const z of sz.data ?? []) {
    const zw = Number(z.width_ft), zl = Number(z.length_ft);
    sizeByDims.set(`${z.style_id}|${zw}|${zl}`, { id: z.id });
    const cur = maxSort.get(z.style_id) ?? -1;
    if ((z.sort_order ?? 0) > cur) maxSort.set(z.style_id, z.sort_order ?? 0);
  }
  // Inclusion cell -> included quantity. 0 = not included (delete the row).
  // Numbers win ("50" -> 50 sq ft, "2" -> 2); legacy yes-tokens mean quantity 1;
  // anything else (blank, "no", garbage) is 0 — same delete behavior as before.
  const parseInclusionQty = (v: unknown): number => {
    if (v === true) return 1;
    const s = String(v ?? "").trim().toLowerCase();
    if (s === "") return 0;
    if (["yes", "y", "true", "x", "included"].includes(s)) return 1;
    const n = Number(s.replace(/[$,\s]/g, ""));
    return Number.isFinite(n) && n > 0 ? Math.round(n) : 0;
  };
  const isLegacyYes = (v: unknown) => v === true || ["yes", "y", "true", "x", "included"].includes(String(v ?? "").trim().toLowerCase());
  // Existing inclusion quantities: a legacy "yes" cell (old saved sheet) PRESERVES a
  // configured qty (e.g. loft 50 sq ft) instead of silently downgrading it to 1.
  const existingQty = new Map<string, number>();   // `${size_id}|${item_key}` -> qty
  const exq = await sb.from("building_size_inclusions").select("size_id, item_key, qty").eq("client_id", clientId);
  if (exq.error) throw exq.error;
  for (const r of exq.data ?? []) existingQty.set(`${r.size_id}|${r.item_key}`, Number(r.qty) || 1);
  const inactiveWord = (v: unknown) => ["no", "n", "0", "false", "inactive"].includes(String(v ?? "").trim().toLowerCase());
  const num = (v: unknown) => { const blank = v === "" || v == null; if (blank) return { blank: true, n: NaN }; return { blank: false, n: Number(String(v).replace(/[$,\s]/g, "")) }; };
  const fmt = (n: number) => String(n);
  let created = 0, updated = 0; const skipped: string[] = [];
  for (const row of rows) {
    const styleName = String(row?.style ?? "").trim();
    const wv = num(row?.width), lv = num(row?.length);
    if (!styleName && wv.blank && lv.blank) continue;   // wholly blank line
    const style = styleByName.get(styleName.toLowerCase());
    if (!style) { skipped.push(`${styleName || "(blank)"}: unknown style`); continue; }
    if (wv.blank && lv.blank) { skipped.push(`${styleName}: missing width & length`); continue; }
    if (!Number.isFinite(wv.n) || !Number.isFinite(lv.n) || wv.n <= 0 || lv.n <= 0) {
      skipped.push(`${styleName} ${row?.width}x${row?.length}: invalid width/length`); continue;
    }
    const w = wv.n, l = lv.n;
    const pr = num(row?.price);
    if (!pr.blank && !Number.isFinite(pr.n)) { skipped.push(`${styleName} ${w}x${l}: invalid price "${row?.price}"`); continue; }
    const price = pr.blank ? null : pr.n;
    const active = !inactiveWord(row?.active) && price != null;   // active intent AND priced
    const label = `${fmt(w)}x${fmt(l)}`;
    const dimKey = `${style.id}|${w}|${l}`;
    let sizeId: string;
    const existing = sizeByDims.get(dimKey);
    if (existing) {
      const up = await sb.from("building_sizes").update({ label, base_price: price, active }).eq("id", existing.id);
      if (up.error) { skipped.push(`${styleName} ${label}: ${up.error.message}`); continue; }
      sizeId = existing.id; updated++;
    } else {
      const nextSort = (maxSort.get(style.id) ?? -1) + 1; maxSort.set(style.id, nextSort);
      const insv = await sb.from("building_sizes").insert(
        { client_id: clientId, style_id: style.id, label, width_ft: w, length_ft: l,
          base_price: price, active, sort_order: nextSort }).select("id").maybeSingle();
      if (insv.error) { skipped.push(`${styleName} ${label}: ${insv.error.message}`); continue; }
      sizeId = insv.data!.id; sizeByDims.set(dimKey, { id: sizeId }); created++;
    }
    const inc = (row.inclusions && typeof row.inclusions === "object") ? row.inclusions : {};
    for (const [itemKey, val] of Object.entries(inc)) {
      if (!itemKey) continue;
      let qty = parseInclusionQty(val);
      if (qty === 1 && isLegacyYes(val)) qty = existingQty.get(`${sizeId}|${itemKey}`) ?? 1;
      const incRes = qty > 0
        ? await sb.from("building_size_inclusions").upsert({ client_id: clientId, size_id: sizeId, item_key: itemKey, included: true, qty }, { onConflict: "size_id,item_key" })
        : await sb.from("building_size_inclusions").delete().eq("size_id", sizeId).eq("item_key", itemKey);
      if (incRes.error) skipped.push(`${styleName} ${label} / ${itemKey}: ${incRes.error.message}`);
    }
  }
  return { imported: created + updated, created, updated, skipped };
}

Deno.serve(withErrorLog("portal-settings", async (req: Request) => {
  // When this request reached the function. The gateway's 150 s idle timeout runs from the
  // request, not from any one call inside it, so a budget that must end before it is measured
  // from here (calibrate_style_ai's model abort).
  const requestStartMs = Date.now();
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  // ── Warm-up ───────────────────────────────────────────────────────────────────────
  // A table-free ping, the same shape as portal-schedule's, so the first real call does not
  // also pay a cold isolate boot (~2.5 s before the first query). Three properties are
  // deliberate and load-bearing:
  //   • it answers BEFORE any client, auth or tenant resolution, so it costs no round trip
  //     and cannot log a refusal — a ping firing on every boot must never fill app_errors;
  //   • it is a QUERY PARAM, not an action, so it needs no GATES entry (preflight
  //     cross-checks gates against action branches) and unknown-action handling is untouched;
  //   • it never reads the request BODY — the code below owns the single parse of that
  //     stream, and consuming it here would break every real call.
  // Booting the isolate IS the whole job; there is nothing to return but the acknowledgement.
  if (new URL(req.url).searchParams.get("warm") === "1") return json({ ok: true });

  const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

  // Auth + tenant resolution, shared with portal-billing / sync-design-status.
  //
  // Authorization: any linked account may READ (status/catalog/contact_activity), but only
  // the tenant owner/admin may MUTATE. The portal UI hides the settings/pricing/colors tabs
  // for role "user", but that is a client-only control — a direct POST would bypass it — so
  // the gate lives in the resolver, server-side.
  //
  // An OPERATOR (app_operators, see _shared/resolveTenant.ts) may additionally pass
  // `targetClientId` to act on another tenant — that is what makes the portal's "view as"
  // mode actually read and write the viewed account instead of the operator's own.
  // Everything below this block is unchanged and simply uses `clientId`.
  const admin = createClient(supabaseUrl, serviceKey);
  const r = await resolveTenant(req, admin, { gates: GATES, readActions: new Set(), defaultAction: "status" });
  if (!r.ok) return json(r.body, r.status);
  const { clientId, role, operator, payload, action, audit, auditStrict, userId, userEmail, canRead, canEdit, access } = r.ctx;

  // Reads are logged best-effort; writes get a durable row (below, per action).
  if (operator) audit(`operator_${action}`).catch(() => {});

  // NOBODY SKIPS THE PAID-FEATURE CHECKS — not even a platform operator (Carolyn 2026-09-15:
  // "if there are parts of the software they haven't paid for and it isn't accessible for
  // them, then it shouldn't be accessible to me either in their account"). Until then an
  // `entitlementExempt` flag here let CSM Synergy staff use Real-Time Pricing, the CRM and
  // QuickBooks on a tenant that never bought them, so an operator could confidently talk a
  // customer through a screen the customer did not have. The accepted cost is that a lapsed
  // subscription now blocks operator repairs on those three settings surfaces until the
  // tenant pays or the feature is comped (client_feature_grants, where the plan allows it).
  // `internal_account` still short-circuits inside hasPaidFeature, so our own tenant is
  // unaffected.

  // ══ ROW SCOPE — contacts:'own' (migration 193) ═══════════════════════════════════════
  //
  // Carolyn, 2026-09-04 @1:02:16, on a builder whose salespeople are independent dealers:
  // "he also doesn't want them to see each other's quotes either … they would only see the
  // list, the pipelines or the quotes that they have created themselves." And @1:09:30, the
  // model she settled on: "we do not ever assign deals. We only assign contacts and
  // followers … if they are not assigned to or following that customer, they can't see
  // anything of it." So a design is visible because its CUSTOMER is, and there is exactly
  // one predicate — public.crm_contact_visible_to — for the whole feature.
  //
  // ⚠️ THE RLS POLICIES IN 193 DO NOTHING IN THIS FILE. `admin` is built from
  // SUPABASE_SERVICE_ROLE_KEY and the service role is BYPASSRLS: every restrictive policy
  // 193 installs is skipped for every query below. Those policies exist for the lists the
  // BROWSER reads straight from PostgREST (portal/02-sales.jsx's Pipeline, Contacts and
  // browsing-leads reads). Anything that reaches a customer's rows through THIS function is
  // filtered here, by hand, or it is not filtered at all.
  //
  // ⚠️ OWNERS ARE ABSOLUTE AND THAT IS WHY THERE IS NO ROLE CHECK HERE. effectiveAccess()
  // short-circuits role === 'owner' to 'edit' on every area before a stored map is consulted,
  // so `access.contacts` is never the string 'own' for an owner, whatever is in their row.
  // The same holds for an operator in view-as (a full map) and for a support operator (the
  // viewed owner's map). Re-testing the role here would be a second copy of that rule, and
  // the version of this filter that forgets it empties the owner's own dashboard.
  const ownContacts = ownContactsOnly(access);

  /**
   * Which of these contact ids may this caller see? Returns null when the check itself
   * failed — callers must dbFail on null and MUST NOT fall back to "show everything",
   * which would turn a transient database error into a silent widening.
   *
   * Answers through public.crm_visible_contact_ids so the edge filter and the RLS policies
   * run the SAME predicate rather than two transcriptions of it. One round trip whatever the
   * list length, and over POST, so there is no URL-length ceiling on a 2000-row Orders tab.
   */
  const visibleContactIds = async (
    ids: (string | null | undefined)[],
  ): Promise<Set<string> | null> => {
    const want = [...new Set(ids.filter((v): v is string => !!v))];
    // Not narrowed: every id asked about is visible. Returned without a round trip, because
    // this is every caller on every tenant until an owner sets the switch on one person.
    if (!ownContacts) return new Set(want);
    if (!want.length) return new Set();
    const { data, error } = await admin.rpc("crm_visible_contact_ids", {
      p_client_id: clientId,
      p_user_id: userId,
      p_ids: want,
    });
    if (error) {
      logEdgeError({
        fn: "portal-settings", req, clientId, code: error.code ?? "contact_scope_failed",
        message: `crm_visible_contact_ids failed: ${error.message ?? "unknown"}`,
        context: { action, ids: want.length },
      }).catch(() => {});
      return null;
    }
    return new Set((data as string[] | null) ?? []);
  };

  /**
   * Keep only the design/lead rows whose customer this caller may see. The rows must already
   * carry `contact_id` — add it to the projection rather than doing a second read.
   *
   * A NULL contact_id is DROPPED, and that is edge case 2 of migration 193 rather than an
   * accident of the Set lookup: crm_ensure_contact returns NULL for a submission carrying
   * neither a phone nor an email, so the row has no customer to be assigned to and no
   * follower to inherit. Nothing to own means nobody but the people who are never narrowed.
   */
  const visibleDesignRows = async <T extends { contact_id?: string | null }>(
    rows: T[],
  ): Promise<T[] | null> => {
    if (!ownContacts) return rows;
    const ids = await visibleContactIds(rows.map((d) => d.contact_id));
    if (!ids) return null;
    return rows.filter((d) => !!d.contact_id && ids.has(d.contact_id));
  };

  /**
   * The same narrowing for a caller that holds SHORT CODES and no rows — it resolves each
   * code to its design's contact_id first. Codes that name no design on this tenant fall out
   * here too, which is the right answer for a list the browser supplied.
   */
  const visibleShortCodes = async (codes: string[]): Promise<string[] | null> => {
    if (!ownContacts) return codes;
    if (!codes.length) return [];
    const { data, error } = await admin.from("designs")
      .select("short_code, contact_id").eq("client_id", clientId).in("short_code", codes);
    if (error) {
      logEdgeError({
        fn: "portal-settings", req, clientId, code: error.code ?? "contact_scope_failed",
        message: `short-code scope read failed: ${error.message ?? "unknown"}`,
        context: { action, codes: codes.length },
      }).catch(() => {});
      return null;
    }
    const kept = await visibleDesignRows((data ?? []) as { short_code: string; contact_id: string | null }[]);
    if (!kept) return null;
    return kept.map((d) => d.short_code);
  };

  /**
   * Refuse a WRITE against a design this caller may not see. Returns a Response to return, or
   * null to carry on.
   *
   * ⚠️ 193 scoped the READS and left the writes, which is a real gap and not a theoretical
   * one: `designs:edit` and `orders:edit` are both Sales Rep presets, and every action below
   * takes a short_code straight from the browser. A rep on contacts:'own' could not SEE a
   * colleague's deal in any list, and could still delete-adjacent it — resend the customer's
   * quote email, raise their invoice, text them a signing link, or attach their design to an
   * inventory unit — by posting a code they guessed or kept from before they were narrowed.
   *
   * Not folded into the GATES table: that answers "may you do this kind of thing at all",
   * which is still the floor here. This answers "to THIS row", which a per-action table
   * cannot express.
   *
   * 404, not 403, matching crm_record's choice — a distinct refusal confirms the design
   * exists, which is the leak in a different shape.
   *
   * A failed check REFUSES rather than allowing. It is the inverse of the read helpers'
   * posture on purpose: a transient error that hides a row is an annoyance, and one that
   * lets a write through is the thing this exists to stop.
   */
  const refuseUnlessDesignVisible = async (code: string): Promise<Response | null> => {
    if (!ownContacts) return null;
    if (!code) return null;                 // the action's own validation reports a blank
    const ok = await visibleShortCodes([code]);
    if (!ok) return dbFail(req, clientId, "check who this customer is assigned to", { message: "contact scope unavailable" });
    if (!ok.includes(code)) return json({ error: "That design is not one of yours." }, 404);
    return null;
  };

  /**
   * ── CONTACT_ROW_SCOPE ── which contact does each contacts:'edit' action touch?
   *
   * Since 2026-09-07 `contacts:'own'` WRITES (access.ts's ownWrites flag — Carolyn: "Yes, let
   * dealers edit their own contacts"), so every one of these actions is now reachable by
   * someone who may only touch their own customers. Passing the gate says they may write
   * something; this table is what says WHICH ROW, and without it the level is a blanket edit
   * on the whole tenant's customer list.
   *
   * A TABLE, for the same reason GATES is one and stated in the same words: these actions are
   * a long if-chain, so a branch with a forgotten check does not fail, it RUNS. Eleven checks
   * written by hand today is eleven checks that survive exactly as long as everyone remembers.
   * scripts/preflight.mjs refuses a push where a contacts:'edit' action in GATES is missing
   * from here, so forgetting fails at the push instead of in a builder's account.
   *
   * How a row is found, in order:
   *   `rowTable`     payload.id names an existing row — read ITS contact. This is the case
   *                  that reads like it needs no check and needs it most: crm_save_note with
   *                  an id updates a note by primary key and never mentions a contact, so
   *                  without this a dealer edits any note on the tenant by guessing an id.
   *   `contactKeys`  payload keys holding a contact id directly.
   *   `codeKeys`     payload keys holding a design short code — resolved to its contact.
   *
   * DENY BY DEFAULT: an own-scoped call that names no contact this caller can see is refused,
   * including when it names nothing at all. That covers migration 193's edge case 2 — a
   * design whose submission carried neither phone nor email has a NULL contact_id, so it has
   * no owner and no follower, and it is invisible to a narrowed reader. A write to it is
   * refused for the same reason rather than falling through to "allowed".
   */
  const CONTACT_ROW_SCOPE: Record<string, {
    rowTable?: string;
    contactKeys?: string[];
    codeKeys?: string[];
    /** Not per-contact at all — refuse a narrowed caller outright. See set_opt_out's twin. */
    tenantWide?: boolean;
  }> = {
    crm_save_contact:      { contactKeys: ["id"] },
    crm_save_note:         { rowTable: "crm_notes",      contactKeys: ["contactId"], codeKeys: ["shortCode"] },
    crm_delete_note:       { rowTable: "crm_notes" },
    crm_save_activity:     { rowTable: "crm_activities", contactKeys: ["contactId"], codeKeys: ["shortCode"] },
    crm_complete_activity: { rowTable: "crm_activities" },
    crm_send_email:        { contactKeys: ["contactId"], codeKeys: ["shortCode"] },
    crm_send_sms:          { contactKeys: ["contactId"], codeKeys: ["shortCode"] },
    crm_record_consent:    { contactKeys: ["contactId"] },
    crm_file_sign:         { contactKeys: ["contactId"] },
    crm_file_attach:       { contactKeys: ["contactId"], codeKeys: ["shortCode"] },
    crm_file_delete:       { rowTable: "crm_files" },
  };

  /**
   * The one call that enforces the table. Runs before dispatch for EVERY action and returns
   * null instantly for anyone who is not narrowed, which is every caller on every tenant
   * until an owner sets somebody to 'Own only'.
   *
   * 404 rather than 403, matching refuseUnlessDesignVisible and crm_record: a distinct
   * refusal would confirm the row exists, which is the same leak wearing a different status
   * code. A failed CHECK refuses too — a transient error that blocks a write is an
   * annoyance, one that lets it through is what this exists to stop.
   */
  const refuseUnlessOwnContactRow = async (): Promise<Response | null> => {
    if (!ownContacts) return null;
    const rule = CONTACT_ROW_SCOPE[action];
    if (!rule) return null;
    if (rule.tenantWide) {
      return json({ error: "That list covers the whole business, and you only have access to your own customers." }, 403);
    }

    const ids: string[] = [];
    const codes: string[] = [];
    const rowId = rule.rowTable && payload.id ? String(payload.id).slice(0, 64) : "";

    if (rowId) {
      const { data, error } = await admin.from(rule.rowTable!)
        .select("contact_id, short_code").eq("client_id", clientId).eq("id", rowId).maybeSingle();
      if (error) return dbFail(req, clientId, "check who this customer is assigned to", error);
      // Gone, or another tenant's: the same answer a narrowed caller gets for a row that is
      // simply not theirs, so the refusal never distinguishes the two.
      if (!data) return json({ error: "That is not one of yours." }, 404);
      if (data.contact_id) ids.push(String(data.contact_id));
      else if (data.short_code) codes.push(String(data.short_code));
    } else {
      for (const k of rule.contactKeys ?? []) {
        if (payload[k]) ids.push(String(payload[k]).slice(0, 64));
      }
      for (const k of rule.codeKeys ?? []) {
        if (payload[k]) codes.push(String(payload[k]).slice(0, 32));
      }
    }

    if (!ids.length && !codes.length) {
      return json({ error: "That is not one of yours." }, 404);
    }
    if (ids.length) {
      const seen = await visibleContactIds(ids);
      if (!seen) return dbFail(req, clientId, "check who this customer is assigned to", { message: "contact scope unavailable" });
      if (ids.some((id) => !seen.has(id))) return json({ error: "That customer is not one of yours." }, 404);
    }
    if (codes.length) {
      const ok = await visibleShortCodes(codes);
      if (!ok) return dbFail(req, clientId, "check who this customer is assigned to", { message: "contact scope unavailable" });
      if (codes.some((c) => !ok.includes(c))) return json({ error: "That design is not one of yours." }, 404);
    }
    return null;
  };

  { const bad = await refuseUnlessOwnContactRow(); if (bad) return bad; }

  // ── Record that a building has been sold ────────────────────────────────────────
  // Carolyn 2026-08-08: "we should never be able to mark it sold. Always needs an invoice."
  // There is no button and no action behind this — a sale is a CONSEQUENCE, recorded in
  // exactly three places, all server-side:
  //
  //   1. HERE, from send_invoice, the moment the customer's invoice is raised.
  //   2. sync-design-status, when a design reaches `invoiced` some other way — the tenant
  //      raised the invoice directly in GoHighLevel, or GHL reports the estimate as paid.
  //   3. The payments_claim_inventory trigger (migration 105), when money is recorded against
  //      the order. Payments are inserted straight from the browser under RLS, so a database
  //      trigger is the only choke point that cannot be bypassed.
  //
  // CLAIM ONLY, NEVER RELEASE, and always a compare-and-swap on `sale_state = 'unsold'`: of
  // two concurrent claims exactly one matches a row, so a building cannot be sold twice. A
  // deliberate release (unsell_inventory) records the design it was released from, and this
  // skips that design — otherwise releasing a wrongly-sold building would be pointless,
  // because the buyer's design is still `invoiced` and the next sync would re-sell it.
  //
  // Best-effort by contract: the invoice has already gone to the customer by the time this
  // runs, so a failure here must never fail that. It is logged, not thrown.
  const claimUnitSale = async (unitId: string, buyerCode: string, why: string) => {
    try {
      const { data: buyer } = await admin.from("designs").select("contact")
        .eq("client_id", clientId).eq("short_code", buyerCode).maybeSingle();
      const now = new Date().toISOString();
      const { data: won, error } = await admin.from("inventory_units").update({
        sale_state: "sold",
        sold_design_short_code: buyerCode,
        sold_first_name: firstNameOf(buyer?.contact),
        sold_at: now,
        sold_by: userId,
        updated_at: now,
      })
        .eq("id", unitId).eq("client_id", clientId)
        .eq("sale_state", "unsold")
        .or(`sale_released_from.is.null,sale_released_from.neq.${buyerCode}`)
        .select("id, serial").maybeSingle();
      if (error) {
        await logEdgeError({
          fn: "portal-settings", req, clientId, code: "inventory_sale_claim_failed",
          message: `claim via ${why} failed for unit ${unitId}: ${(error as { code?: string }).code ?? ""}`,
        });
        return;
      }
      if (won) await auditStrict("portal_inventory_sold", 1, `unit=${unitId} serial=${won.serial} via=${why} buyer=${buyerCode}`);
    } catch (e) {
      await logEdgeError({
        fn: "portal-settings", req, clientId, code: "inventory_sale_claim_failed",
        message: `claim via ${why} threw for unit ${unitId}: ${(e as Error)?.message ?? ""}`,
      });
    }
  };

  // ── The caller's own name and phone ─────────────────────────────────────────────
  // Keyed on userId from the verified session — NEVER on anything in the body — so this
  // cannot be pointed at another person's row whatever the caller sends. Any role may use
  // it (see SELF_ACTIONS): a "user" account still needs to be able to fill in its own name.
  if (action === "get_profile") {
    const { data, error } = await admin
      .from("client_users").select("full_name, phone, role").eq("user_id", userId).maybeSingle();
    if (error) return dbFail(req, clientId, "load your profile", error);
    return json({
      fullName: data?.full_name ?? "",
      phone: data?.phone ?? "",
      role: data?.role ?? role,
      email: userEmail,
      // Drives the one-time nudge: users predating migration 060 have neither.
      needsDetails: !(data?.full_name || "").trim(),
    });
  }

  if (action === "save_profile") {
    const fullName = String(payload?.fullName ?? "").trim().slice(0, 120);
    const phone = String(payload?.phone ?? "").trim().slice(0, 40);
    if (!fullName) return json({ error: "Please enter your name." }, 400);
    const { error } = await admin.from("client_users")
      .update({ full_name: fullName, phone: phone || null })
      .eq("user_id", userId);        // own row only
    if (error) return dbFail(req, clientId, "save your name and phone", error);
    return json({ ok: true, fullName, phone });
  }

// ── WHAT A COLOUR SAVE ACTUALLY FAILED ON ────────────────────────────────────────────
// Carolyn read a Postgres error out loud on the 2026-08-28 call (@55:00): "the color is
// skipped, black is a duplicate key, it violates the unique constraint of colors, client and
// ID label key." She then proposed working around it by renaming the colours BLM and BLS.
//
// TWO SEPARATE FAILURES WERE HAPPENING THERE. The constraint itself was wrong -- fixed in
// 161, a colour name is unique within a SECTION now -- and, underneath that, `save_colors`
// was pasting the driver's raw text into the response, so the one person who could not act
// on a constraint name was the only person who ever saw it.
//
// This translates the constraints we own into a sentence naming what to do. Anything
// unrecognised still falls through to the raw message: inventing a friendly wrapper for an
// error nobody has seen yet just hides the next surprise.
function colorSaveReason(err: { message?: string; code?: string }, label: string, section: string): string {
  const raw = String(err?.message ?? "");
  const where = section === "shingle" ? "shingle colours" : section === "metal" ? "metal colours" : "paint colours";
  if (err?.code === "23505" || /duplicate key|unique constraint/i.test(raw)) {
    if (/_code_uniq/.test(raw)) {
      return `another colour in your ${where} already uses that code. Codes have to be unique inside a section because they become part of a building's serial number.`;
    }
    if (/_label_uniq|client_id_label_key/.test(raw)) {
      return `you already have a colour called "${label}" in your ${where}. The same name in a DIFFERENT section is fine — a shingle Black and a metal Black can both exist.`;
    }
    return `something with those details already exists in your ${where}.`;
  }
  return raw;
}

  if (action === "status") {
    // The caller's own preferences row. Best-effort: a failure here must never stop the
    // bootstrap call that every role depends on to learn its access map.
    let myPrefs: Record<string, unknown> | null = null;
    if (userId) {
      const { data: pr } = await admin.from("client_users")
        .select("prefs").eq("user_id", userId).limit(1).maybeSingle();
      myPrefs = (pr && pr.prefs && typeof pr.prefs === "object" && !Array.isArray(pr.prefs))
        ? pr.prefs as Record<string, unknown> : null;
    }
    const { data, error } = await admin
      .from("client_settings")
      .select("ghl_location_id, ghl_api_key, ghl_pipeline_id, ghl_stage_send_quote_id, ghl_stage_accepted_id, ghl_stage_invoiced_id, ghl_stage_delivered_id, business_name, business_phone, business_website, business_address, business_logo_url, quote_terms, beta_mode, beta_email, show_pricing, invoice_in_ghl, ghl_invoicing_allowed, ss_quote_next, ss_quote_prefix, ss_invoice_next, ss_invoice_prefix, ss_tax_rate, ss_tax_label, ss_tax_delivery, co_unlock_required, co_free_days, co_fee_cents, co_fee_taxable, co_fee_label, co_unlock_hours, email_provider, email_domain_status, updated_at")
      .eq("client_id", clientId)
      .maybeSingle();
    if (error) return dbFail(req, clientId, "load your settings", error);
    // Designer branding lives in client_configs (drives the public ?client= link).
    //
    // ⚠️ THE FALLBACK SELECT IS LOAD-BEARING (styles_per_row, migration 232, 2026-09-15). This
    // read swallows its error by design — status is the bootstrap every role needs — so a select
    // naming a column the database does not have yet returns cfg = null, not a failure. The
    // Branding card then loads BLANK, and the owner's next Save Branding sends those blanks and
    // wipes company name, tagline and colours on beta AND production. Deploying this function a
    // minute ahead of 232 would do exactly that to every tenant. Retrying with the pre-232 column
    // list turns that into "stylesPerRow reads as default" instead; a save that carries
    // stylesPerRow then fails loudly on the missing column and writes nothing (one UPDATE).
    // Apply 232 first anyway — this is the seatbelt, not the plan.
    let { data: cfg, error: cfgErr } = await admin
      .from("client_configs")
      .select("company_name, tagline, logo_url, accent_color, header_bg, styles_per_row")
      .eq("client_id", clientId)
      .maybeSingle();
    if (cfgErr) {
      ({ data: cfg } = await admin
        .from("client_configs")
        .select("company_name, tagline, logo_url, accent_color, header_bg")
        .eq("client_id", clientId)
        .maybeSingle() as any);
    }
    // The builder's default login-code channel (migration 231). ITS OWN READ, AND TOLERANT, ON
    // PURPOSE: `status` is the portal shell's bootstrap, so naming customer_login_default in the
    // select above would fail this action — and black out every tenant's portal — if this deploys
    // before 231 is applied. A failed read shows "text", which is what the default means anyway.
    const { data: loginPref, error: loginPrefErr } = canRead("settings_crm")
      ? await admin.from("client_settings").select("customer_login_default").eq("client_id", clientId).maybeSingle()
      : { data: null, error: null };
    // STATUS FIELD FILTER. This action is "open" in GATES because it is the shell's
    // bootstrap: every role needs clientId/role/branding/business identity to render the
    // portal at all, so denying it would black out the app rather than close one card. The
    // CRM wiring inside it is a different matter — pipeline and stage ids are settings_crm
    // material with no business reaching a driver's browser — so it is filtered here
    // instead. `access` rides along so portal.html renders tabs from the SAME resolved map
    // the server just enforced, rather than from a second copy of the rules that can drift.
    const crm = canRead("settings_crm")
      ? {
        configured: Boolean(data?.ghl_location_id && data?.ghl_api_key),
        ghlLocationIdMasked: maskId(data?.ghl_location_id ?? null),
        hasApiKey: Boolean(data?.ghl_api_key),
        ghlPipelineId: data?.ghl_pipeline_id ?? null,
        ghlStageSendQuoteId: data?.ghl_stage_send_quote_id ?? null,
        ghlStageAcceptedId: data?.ghl_stage_accepted_id ?? null,
        ghlStageInvoicedId: data?.ghl_stage_invoiced_id ?? null,
        ghlStageDeliveredId: data?.ghl_stage_delivered_id ?? null,
        betaMode: Boolean(data?.beta_mode),
        betaEmail: data?.beta_email ?? null,
        // Who issues the paperwork (migration 121). Defaults TRUE for every tenant, so a
        // row that predates the column — or a tenant with no client_settings row at all —
        // reads as "invoice through the CRM", i.e. today's behaviour.
        invoiceInGhl: data?.invoice_in_ghl !== false,
        // MAY they invoice through the CRM at all (migration 217)? Carolyn 2026-09-07:
        // "The feature for payments to go through GHL should only show in Junior Barns as he
        // is an active user. All other builders will only have the option to invoice through
        // SS." Default false, so a row predating the column reads as NOT allowed — the safe
        // direction, since the worst case is a builder asking why the checkbox went away
        // rather than one quietly keeping a route we are retiring.
        //
        // This is only what the CARD RENDERS. The control is in `save` below; a hidden
        // checkbox is a courtesy.
        ghlInvoicingAllowed: data?.ghl_invoicing_allowed === true,
        ssQuoteNext: data?.ss_quote_next ?? null,
        ssQuotePrefix: data?.ss_quote_prefix ?? "",
        ssInvoiceNext: data?.ss_invoice_next ?? null,
        ssInvoicePrefix: data?.ss_invoice_prefix ?? "",
        // Sales tax (migration 148). The rate is surfaced as a PERCENT — it is stored as a
        // fraction, and a settings card that round-trips 0.0725 into a box labelled "%" is how
        // a tenant ends up quoting at 0.07%.
        ssTaxRate: data?.ss_tax_rate == null ? null : Math.round(Number(data.ss_tax_rate) * 1000000) / 10000,
        ssTaxLabel: data?.ss_tax_label ?? "Sales tax",
        // Changing a signed order (migrations 209-216). The fee is surfaced in DOLLARS —
        // the card asks for dollars, and a card that reads cents back into a dollar box is
        // how a $150 fee becomes $15,000 on the first re-save.
        coUnlockRequired: data?.co_unlock_required === true,
        coFreeDays: Number(data?.co_free_days ?? 0),
        coFee: data?.co_fee_cents == null ? 0 : Math.round(Number(data.co_fee_cents)) / 100,
        coFeeTaxable: data?.co_fee_taxable !== false,
        coFeeLabel: data?.co_fee_label ?? "Change order fee",
        coUnlockHours: Number(data?.co_unlock_hours ?? 72),
        ssTaxDelivery: data?.ss_tax_delivery === true,
        // "Customer login code: Text / Email" (migration 231). 'sms' | 'email'; null and a failed
        // read both mean text.
        customerLoginDefault: !loginPrefErr && loginPref?.customer_login_default === "email" ? "email" : "sms",
        // For the Settings card's email warning (decision 5, 2026-08-23: warn-but-allow):
        // in SS mode there is no GHL fallback, so a tenant without live sending can't
        // email quotes/invoices at all — the card says so, loudly, without blocking.
        emailReady: data?.email_provider === "resend" && data?.email_domain_status === "verified",
      }
      : {};
    return json({
      ok: true,
      // clientId is the RESOLVED tenant (the viewed one in operator mode). portal.html's
      // invoke wrapper compares it against the targetClientId it injected and refuses the
      // response if they disagree — that tripwire is what stops a frontend deployed ahead
      // of this function from silently reading/writing the operator's own tenant.
      clientId,
      role,
      operatorMode: Boolean(operator),
      access,
      // ── THE CALLER'S OWN PORTAL PREFERENCES (165) ────────────────────────────────
      // Rides `status` because the shell already awaits it at boot for `access`, and a
      // default view that arrives a round trip late shows the wrong tab first and then
      // jumps -- which is worse than not having the setting.
      //
      // ⚠️ Keyed on userId, never on clientId: this is PER PERSON. Two people at the same
      // builder legitimately want different defaults, which is the whole reason 165 put
      // the column on client_users rather than on client_settings.
      //
      // In operator view-as this is still the OPERATOR's own row -- they are the one
      // looking at the screen, and borrowing the viewed tenant's owner's layout would be
      // both wrong and a small information leak.
      prefs: myPrefs,
      ...crm,
      businessName: data?.business_name ?? null,
      businessPhone: data?.business_phone ?? null,
      businessWebsite: data?.business_website ?? null,
      businessAddress: data?.business_address ?? null,
      businessLogoUrl: data?.business_logo_url ?? null,
      quoteTerms: data?.quote_terms ?? null,
      showPricing: Boolean(data?.show_pricing),
      updatedAt: data?.updated_at ?? null,
      // designer branding (client_configs)
      branding: {
        companyName: cfg?.company_name ?? null,
        tagline: cfg?.tagline ?? null,
        logoUrl: cfg?.logo_url ?? null,
        accentColor: cfg?.accent_color ?? null,
        headerBg: cfg?.header_bg ?? null,
        // Building styles per row on the designer (232). null = never chosen, which the card
        // shows as 8 and the designer treats as 8 — the same default, stated in two places.
        stylesPerRow: (cfg as { styles_per_row?: number | null } | null)?.styles_per_row ?? null,
      },
    });
  }

  // ── SAVING THEM ──────────────────────────────────────────────────────────────────
  // Ahsan, 2026-08-28 @42:28: "all of these settings for contact cards, the pipeline cards,
  // and the default one, I think should add, in settings, add another tab ... for structure
  // studio settings."
  //
  // WHITELIST-REBUILT, like every other save in this file. An open jsonb column written
  // straight from the browser is a place for anything to end up, and this one is read back
  // into the shell on every boot. Only the keys below survive.
  //
  // No gate entry beyond being signed in, deliberately: these are one person's own view
  // preferences, not tenant data. A sales rep may set their own default view.
  if (action === "save_prefs") {
    if (!userId) return json({ error: "Sign in again to save your preferences." }, 401);
    const raw = (payload.prefs && typeof payload.prefs === "object" && !Array.isArray(payload.prefs))
      ? payload.prefs as Record<string, any> : {};
    const clean: Record<string, unknown> = {};
    if (raw.designsView === "list" || raw.designsView === "pipeline") clean.designsView = raw.designsView;
    // A person's own reply-to address (Carolyn 2026-09-04 @35:06: "every user should be able to
    // go in and say, when somebody replies to an email, send it here. But that should be in
    // their profile"). It is ADVERTISED TO CUSTOMERS — sendTenantEmail puts it in Reply-To
    // alongside the CRM routing address — so it is validated rather than merely trimmed, and an
    // unusable value is DROPPED rather than stored: a malformed address in a header is a send
    // Resend may 422 outright, and a 422 is a permanent verdict, so the whole email is lost
    // rather than retried.
    //
    // ⚠️ THE WHITELIST IS THE ONLY REGISTER OF WHAT SURVIVES. `clean` is rebuilt from scratch
    // and the update below REPLACES the whole jsonb blob, so a key that is not listed here does
    // not merely fail to save — it is DESTROYED by the next save from any screen, including
    // someone changing their Pipeline default on the same card. Every future per-user pref has
    // to be added here or it silently evaporates.
    //
    // 320 is the RFC 5321 maximum address length and matches the beta_email cap. An empty
    // string is how the UI clears it, and correctly arrives here as "drop the key".
    if (typeof raw.replyToEmail === "string") {
      const addr = raw.replyToEmail.trim().slice(0, 320);
      if (addr && /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(addr)) clean.replyToEmail = addr;
    }
    // Card order is a list of section keys. Unknown keys are kept rather than dropped here
    // and filtered at RENDER time instead -- the server would otherwise silently delete a
    // card belonging to a newer frontend than itself, and the user would watch their layout
    // revert every time they saved from a tab that had not reloaded yet.
    const order = (raw.cardOrder && typeof raw.cardOrder === "object" && !Array.isArray(raw.cardOrder)) ? raw.cardOrder : null;
    if (order) {
      const co: Record<string, string[]> = {};
      for (const k of ["contact", "design"]) {
        if (Array.isArray(order[k])) {
          co[k] = order[k].filter((s: unknown) => typeof s === "string").slice(0, 40).map((s: string) => s.slice(0, 40));
        }
      }
      if (Object.keys(co).length) clean.cardOrder = co;
    }
    const { error } = await admin.from("client_users")
      .update({ prefs: Object.keys(clean).length ? clean : null })
      .eq("user_id", userId);
    if (error) return dbFail(req, clientId, "save your preferences", error);
    return json({ ok: true, prefs: Object.keys(clean).length ? clean : null });
  }

  if (action === "save") {
    const updates: Record<string, unknown> = {};
    // Capped, because every one of these is rendered onto a customer-facing estimate or
    // used as a credential. Uncapped, a single save could park an unbounded blob in a
    // service-role table that submit-estimate then tries to put on a PDF. Limits are
    // generous enough that no legitimate value is near them — quote_terms is the only
    // long-form field and 8k is several screens of terms.
    const trimOrNull = (v: unknown, max = 300) => {
      const s = String(v ?? "").trim().slice(0, max);
      return s ? s : null;
    };
    // Text fields: present in body → written (empty string clears to null).
    if ("ghlLocationId" in payload) updates.ghl_location_id = trimOrNull(payload.ghlLocationId);
    if ("ghlPipelineId" in payload) updates.ghl_pipeline_id = trimOrNull(payload.ghlPipelineId);
    if ("ghlStageSendQuoteId" in payload) updates.ghl_stage_send_quote_id = trimOrNull(payload.ghlStageSendQuoteId);
    if ("ghlStageAcceptedId" in payload) updates.ghl_stage_accepted_id = trimOrNull(payload.ghlStageAcceptedId);
    if ("ghlStageInvoicedId" in payload) updates.ghl_stage_invoiced_id = trimOrNull(payload.ghlStageInvoicedId);
    if ("ghlStageDeliveredId" in payload) updates.ghl_stage_delivered_id = trimOrNull(payload.ghlStageDeliveredId);
    if ("businessName" in payload) updates.business_name = trimOrNull(payload.businessName, 200);
    if ("businessPhone" in payload) updates.business_phone = trimOrNull(payload.businessPhone, 40);
    if ("businessWebsite" in payload) updates.business_website = trimOrNull(payload.businessWebsite, 300);
    if ("businessLogoUrl" in payload) updates.business_logo_url = trimOrNull(payload.businessLogoUrl, 1000);
    if ("quoteTerms" in payload) updates.quote_terms = trimOrNull(payload.quoteTerms, 8000);
    if ("betaEmail" in payload) updates.beta_email = trimOrNull(payload.betaEmail, 320);
    if ("betaMode" in payload) updates.beta_mode = Boolean(payload.betaMode);
    if ("showPricing" in payload) updates.show_pricing = Boolean(payload.showPricing);
    // Tentative — the capability check below can force this to false. See migration 217.
    if ("invoiceInGhl" in payload) updates.invoice_in_ghl = Boolean(payload.invoiceInGhl);
    // The quote-number START. Blank clears it back to "not set"; anything else must be a
    // whole positive number, because it is allocated with +1 and printed on a customer's
    // quote. A float or a stray "1,000" silently becoming NaN — and then 1 — is exactly the
    // collision with a tenant's existing paperwork that this field exists to avoid.
    if ("ssQuoteNext" in payload) {
      const raw = String(payload.ssQuoteNext ?? "").trim();
      if (!raw) updates.ss_quote_next = null;
      else {
        const n = Number(raw);
        if (!Number.isInteger(n) || n < 1 || n > 2_000_000_000) {
          return json({ error: "The starting quote number must be a whole number, 1 or higher." }, 400);
        }
        updates.ss_quote_next = n;
      }
    }
    // Prefix is printed on the customer's quote, so the charset is bounded to what a
    // document number legitimately needs — no spaces, no punctuation that could be read as
    // markup on the PDF or in the email subject.
    if ("ssQuotePrefix" in payload) {
      const p = String(payload.ssQuotePrefix ?? "").trim().slice(0, 12);
      if (p && !/^[A-Za-z0-9-]+$/.test(p)) {
        return json({ error: "The quote prefix can only use letters, numbers and dashes — for example INV or JB-." }, 400);
      }
      updates.ss_quote_prefix = p;
    }
    // The INVOICE pair (migration 125) — a separate sequence by decision (2026-08-23):
    // same integer and charset rules as the quote pair above.
    if ("ssInvoiceNext" in payload) {
      const raw = String(payload.ssInvoiceNext ?? "").trim();
      if (!raw) updates.ss_invoice_next = null;
      else {
        const n = Number(raw);
        if (!Number.isInteger(n) || n < 1 || n > 2_000_000_000) {
          return json({ error: "The starting invoice number must be a whole number, 1 or higher." }, 400);
        }
        updates.ss_invoice_next = n;
      }
    }
    // The sales tax rate, entered as a PERCENT and stored as a FRACTION. Blank clears it back
    // to "not set", which the guard below then refuses to leave SS mode with. An explicit 0 is
    // a real answer and must survive — hence the blank/zero distinction rather than falsiness.
    if ("ssTaxRate" in payload) {
      const raw = String(payload.ssTaxRate ?? "").trim();
      if (!raw) updates.ss_tax_rate = null;
      else {
        const pct = Number(raw);
        if (!Number.isFinite(pct) || pct < 0 || pct > 25) {
          return json({ error: "The sales tax rate must be a percentage between 0 and 25 — for example 7.25." }, 400);
        }
        // 5dp, matching numeric(7,5): 7.25% -> 0.0725. Rounded here so the stored value is the
        // one the card will read back, rather than a float that redisplays as 7.249999.
        updates.ss_tax_rate = Math.round((pct / 100) * 100000) / 100000;
      }
    }
    if ("ssTaxLabel" in payload) {
      // Printed on the customer's document, so bounded like the numbering prefixes are.
      const l = String(payload.ssTaxLabel ?? "").trim().slice(0, 40);
      updates.ss_tax_label = l || "Sales tax";
    }
    if ("ssTaxDelivery" in payload) updates.ss_tax_delivery = Boolean(payload.ssTaxDelivery);

    // How the designer's login sheet sends a customer's code FIRST (migration 231; expo plan 3.6,
    // Ahsan 2026-09-15): 'sms' (Text) or 'email'. Blank clears it back to the default, text.
    // customer-auth login_options reads it, and only ever as a preference among the channels the
    // deployment can actually deliver. Written only when the key is sent, so a save from a portal
    // that predates the control never touches the column (and cannot fail on it before 231 exists).
    if ("customerLoginDefault" in payload) {
      const v = String(payload.customerLoginDefault ?? "").trim().toLowerCase();
      if (v && v !== "sms" && v !== "email") {
        return json({ error: "The customer login code can be sent by text or by email." }, 400);
      }
      updates.customer_login_default = v || null;
    }

    // ── CHANGING A SIGNED ORDER (migrations 209-216) ────────────────────────────────────
    // Carolyn 2026-09-06: "add a feature in the settings that allow admin/builder to set how
    // many days after an order is written that a sales rep can do a change order without
    // their approval ... and the admin should be able to set a $ amount as a change order
    // fee (if they want) and it automatically gets applied (after said amount of days)".
    //
    // Every bound below is the SAME one the database holds, restated so the builder is
    // stopped at the control they just touched with a sentence rather than at a constraint.
    if ("coUnlockRequired" in payload) updates.co_unlock_required = Boolean(payload.coUnlockRequired);

    if ("coFreeDays" in payload) {
      const raw = String(payload.coFreeDays ?? "").trim();
      const n = raw === "" ? 0 : Number(raw);
      if (!Number.isFinite(n) || !Number.isInteger(n) || n < 0 || n > 365) {
        return json({ error: "The free-change window has to be a whole number of days between 0 and 365. Enter 0 for no free window." }, 400);
      }
      updates.co_free_days = n;
    }

    if ("coFee" in payload) {
      // Entered in DOLLARS, stored in CENTS. The ceiling is deliberate and low: this is a
      // fee for paperwork, and a fat-fingered 15000 would otherwise land on a customer's
      // invoice as $15,000 with a real signature request attached to it.
      const raw = String(payload.coFee ?? "").trim();
      const d = raw === "" ? 0 : Number(raw);
      if (!Number.isFinite(d) || d < 0 || d > 5000) {
        return json({ error: "The change order fee has to be an amount between $0 and $5,000. Enter 0 for no fee." }, 400);
      }
      updates.co_fee_cents = Math.round(d * 100);
    }

    if ("coFeeTaxable" in payload) updates.co_fee_taxable = Boolean(payload.coFeeTaxable);

    if ("coFeeLabel" in payload) {
      // Printed on the customer's invoice, so bounded exactly like the tax label beside it.
      const l = String(payload.coFeeLabel ?? "").trim().slice(0, 40);
      updates.co_fee_label = l || "Change order fee";
    }

    if ("coUnlockHours" in payload) {
      const raw = String(payload.coUnlockHours ?? "").trim();
      const n = raw === "" ? 72 : Number(raw);
      if (!Number.isFinite(n) || !Number.isInteger(n) || n < 1 || n > 720) {
        return json({ error: "An unlock has to last between 1 and 720 hours (30 days)." }, 400);
      }
      updates.co_unlock_hours = n;
    }

    // ── THE MERGED-STATE REFUSALS: a number that is stored, invisible, and doing nothing ──
    // Both of these are settings that LOOK set and have no effect, which is the worst kind
    // of setting — a builder believes they are charging for late changes and are not.
    // Checked against the merged state because the controls can arrive in separate saves.
    if ("coFee" in payload || "coUnlockRequired" in payload || "invoiceInGhl" in payload) {
      const { data: curCo } = await admin.from("client_settings")
        .select("co_unlock_required, co_fee_cents, invoice_in_ghl").eq("client_id", clientId).maybeSingle();
      const nextFee = "coFee" in payload ? Number(updates.co_fee_cents) : Number(curCo?.co_fee_cents ?? 0);
      const nextRequired = "coUnlockRequired" in payload
        ? Boolean(updates.co_unlock_required)
        : curCo?.co_unlock_required === true;
      const nextInGhl = "invoiceInGhl" in payload ? Boolean(payload.invoiceInGhl) : curCo?.invoice_in_ghl !== false;

      // 1. In CRM mode GoHighLevel owns the documents. There is nothing of ours to print a
      //    fee line on, so the money would simply never be charged.
      if (nextFee > 0 && nextInGhl) {
        return json({
          error: "A change order fee can only be charged on paperwork StructureStudio issues. Your quotes and invoices are created in your CRM right now, so there is nothing here for the fee to appear on — switch that off above first, or leave the fee at 0.",
        }, 400);
      }
      // 2. THE FEE RIDES THE UNLOCK. order_amendment_gate only quotes a fee on the 'unlock'
      //    authority — inside the free window a change is free by definition, and with the
      //    approval requirement off the whole regime is dormant and every change is free.
      //    So a fee set without it is a number nobody will ever be charged.
      if (nextFee > 0 && !nextRequired) {
        return json({
          error: "A change order fee is charged when an admin or crew leader unlocks a signed order — so it only applies once you require approval for changes. Switch that on, or leave the fee at 0.",
        }, 400);
      }
    }

    if ("ssInvoicePrefix" in payload) {
      const p = String(payload.ssInvoicePrefix ?? "").trim().slice(0, 12);
      if (p && !/^[A-Za-z0-9-]+$/.test(p)) {
        return json({ error: "The invoice prefix can only use letters, numbers and dashes — for example INV-." }, 400);
      }
      updates.ss_invoice_prefix = p;
    }

    // Turning CRM invoicing OFF hands the numbering to us, so BOTH start values (quote AND
    // invoice — separate sequences, migration 125) have to exist before the switch flips —
    // otherwise the first SS document would begin at 1 and collide with the tenant's
    // existing paperwork. Checked against the MERGED state (the controls can arrive in
    // separate saves), the same way the beta pair below is.
    if ("invoiceInGhl" in payload || "ssQuoteNext" in payload || "ssInvoiceNext" in payload || "ssTaxRate" in payload) {
      const { data: curInv } = await admin
        .from("client_settings").select("invoice_in_ghl, ghl_invoicing_allowed, ss_quote_next, ss_invoice_next, ss_tax_rate, ss_quote_prefix, ss_invoice_prefix").eq("client_id", clientId).maybeSingle();
      // ── CRM INVOICING IS A CAPABILITY NOW (migration 217, Carolyn 2026-09-07) ───────────
      // "All other builders will only have the option to invoice through SS." A tenant
      // without the flag can write only FALSE here, whatever the body says — the browser
      // hides the checkbox, and this is what makes hiding it mean something.
      //
      // Forced only when the key is PRESENT. A non-allowed tenant still on the CRM path who
      // saves a neighbouring field (a tax label, a prefix) must not be silently flipped into
      // paperwork they have set no numbering for; the flip belongs to the save that comes
      // from the Quotes & Invoices card, which always posts this key.
      const mayInvoiceInGhl = curInv?.ghl_invoicing_allowed === true;
      if ("invoiceInGhl" in payload && !mayInvoiceInGhl) updates.invoice_in_ghl = false;
      const nextInGhl = "invoiceInGhl" in payload
        ? (mayInvoiceInGhl && Boolean(payload.invoiceInGhl))
        : curInv?.invoice_in_ghl !== false;
      const nextQuoteStart = "ssQuoteNext" in payload ? updates.ss_quote_next : (curInv?.ss_quote_next ?? null);
      const nextInvoiceStart = "ssInvoiceNext" in payload ? updates.ss_invoice_next : (curInv?.ss_invoice_next ?? null);
      const nextTaxRate = "ssTaxRate" in payload ? updates.ss_tax_rate : (curInv?.ss_tax_rate ?? null);
      if (!nextInGhl && nextQuoteStart == null) {
        return json({
          error: "StructureStudio needs a starting quote number before it can issue your quotes — set one so your numbering continues where your CRM left off.",
        }, 400);
      }
      if (!nextInGhl && nextInvoiceStart == null) {
        return json({
          error: "StructureStudio needs a starting invoice number too — invoices number separately from quotes, so set where they should begin.",
        }, 400);
      }
      // A rate is as mandatory as a number, and for the same reason: refuse rather than invent.
      // Rates come from each quote's delivery address, but this one is what gets charged when
      // that lookup is unavailable — so without it there is no defensible figure to fall back
      // to, and an untaxed invoice goes out that nobody was ever asked about. 0 is accepted;
      // "unanswered" is not (Carolyn 2026-08-26).
      if (!nextInGhl && nextTaxRate == null) {
        return json({
          error: "StructureStudio needs a sales tax rate before it can issue your invoices — set one so quotes can still be taxed if the delivery address can't be looked up. Enter 0% if you don't collect sales tax.",
        }, 400);
      }

      // ── THE COUNTER HAS A FLOOR: WHAT HAS ALREADY BEEN ISSUED ────────────────────────
      // Both allocators (123 / 125) pre-increment and hand back what they took, so a number
      // is spent the moment a document carries it. Nothing stopped this field being set back
      // BELOW that: the next quote or invoice then reuses a number a customer is already
      // holding paperwork for. Invoices fail the loudest — migration 125's partial unique
      // index refuses the second ledger row — but that refusal lands mid-send, after the
      // number is spent and the PDF is written, which is far too late to be the control.
      //
      // Compared WITHIN THE CURRENT PREFIX, never across every row. Switching prefixes
      // legitimately restarts the series (INV-1 and 2026-1 are different books), so the
      // comparison uses the prefix this save is leaving in place, and a genuinely new prefix
      // simply has no issued numbers to clear.
      //
      // Gaps stay fine (123/125's own property): the rule is only "not at or below one you
      // have already used", never "exactly one more than the last".
      const numericTail = (value: unknown, prefix: string): number | null => {
        const s = String(value ?? "");
        if (prefix && !s.startsWith(prefix)) return null;
        const tail = s.slice(prefix.length);
        return /^\d+$/.test(tail) ? Number(tail) : null;
      };
      // Newest rows first and capped: numbers are handed out in increasing order, so the
      // most recent documents carry the highest ones — the cap bounds the read on a tenant
      // with years of history without changing the answer.
      const highestIssued = async (
        table: string, column: string, orderBy: string, prefix: string,
        // Restricts invoice_sends to OUR series: a GHL-converted row carries that CRM's
        // invoice number, which is a different book entirely.
        issuedBy?: string,
      ): Promise<number | null> => {
        let q = admin.from(table).select(column)
          .eq("client_id", clientId).not(column, "is", null);
        if (issuedBy) q = q.eq("issued_by", issuedBy);
        const { data, error } = await q.order(orderBy, { ascending: false }).limit(1000);
        if (error) throw error;
        let max: number | null = null;
        // deno-lint-ignore no-explicit-any
        for (const r of ((data ?? []) as any[])) {
          const n = numericTail(r?.[column], prefix);
          if (n != null && (max == null || n > max)) max = n;
        }
        return max;
      };

      if ("ssInvoiceNext" in payload && typeof updates.ss_invoice_next === "number") {
        const prefix = String(("ssInvoicePrefix" in payload ? updates.ss_invoice_prefix : curInv?.ss_invoice_prefix) ?? "");
        let issued: number | null = null;
        try { issued = await highestIssued("invoice_sends", "invoice_number", "created_at", prefix, "structurestudio"); }
        catch (e) { return dbFail(req, clientId, "check your invoice numbering", e); }
        if (issued != null && (updates.ss_invoice_next as number) <= issued) {
          return json({
            error: `You have already issued invoice ${prefix}${issued}. The next invoice number has to be higher than that, or two invoices would carry the same number — try ${prefix}${issued + 1}.`,
          }, 409);
        }
      }
      if ("ssQuoteNext" in payload && typeof updates.ss_quote_next === "number") {
        const prefix = String(("ssQuotePrefix" in payload ? updates.ss_quote_prefix : curInv?.ss_quote_prefix) ?? "");
        let issued: number | null = null;
        try { issued = await highestIssued("designs", "ss_quote_number", "created_at", prefix); }
        catch (e) { return dbFail(req, clientId, "check your quote numbering", e); }
        if (issued != null && (updates.ss_quote_next as number) <= issued) {
          return json({
            error: `You have already issued quote ${prefix}${issued}. The next quote number has to be higher than that, or two quotes would carry the same number — try ${prefix}${issued + 1}.`,
          }, 409);
        }
      }
    }

    // Beta mode has a CONSEQUENCE now (submit-estimate redirects the estimate email to
    // beta_email instead of the customer), so the pair is validated as a pair. Refusing the
    // save is the only place this can be caught before a tenant believes they are protected
    // — submit-estimate's matching guard fires at submit time, which is later and louder
    // than it needs to be. This save is presence-based and the two fields arrive from
    // different cards, so the check is against the MERGED state, not just the payload.
    if ("betaMode" in payload || "betaEmail" in payload) {
      const { data: curBeta } = await admin
        .from("client_settings").select("beta_mode, beta_email").eq("client_id", clientId).maybeSingle();
      const nextMode = "betaMode" in payload ? Boolean(payload.betaMode) : Boolean(curBeta?.beta_mode);
      const nextEmail = String(
        ("betaEmail" in payload ? updates.beta_email : curBeta?.beta_email) ?? "",
      ).trim();
      if (nextEmail && !isEmail(nextEmail)) {
        return json({ error: "That test inbox is not a valid email address." }, 400);
      }
      if (nextMode && !nextEmail) {
        return json({
          error: "Beta mode needs a test inbox — that is the address estimates go to instead of your customers. Add one, or leave beta mode off.",
        }, 400);
      }
    }
    // Allowlisted, not passed through. This jsonb lands in submit-estimate's
    // `businessDetails.address` and is rendered onto the customer's estimate, so whatever
    // is stored here leaves the system on a branded document. The previous version wrote
    // any object verbatim — no key list, no caps, no size limit (and `typeof [] === "object"`,
    // so an array passed too). Same `str(v, max)` shape as save_location below, which had
    // it right; these are the only five keys the portal sends and the only ones GHL reads.
    if ("businessAddress" in payload) {
      const a = payload.businessAddress;
      if (a && typeof a === "object" && !Array.isArray(a)) {
        const str = (v: unknown, max: number) => { const s = String(v ?? "").trim().slice(0, max); return s || null; };
        const addr = {
          addressLine1: str((a as any).addressLine1, 200),
          city: str((a as any).city, 100),
          state: str((a as any).state, 60),
          postalCode: str((a as any).postalCode, 12),
          countryCode: str((a as any).countryCode, 2) ?? "US",
        };
        // An address of nothing but a country code is not an address — store null so the
        // estimate omits the block entirely rather than printing a stray "US".
        const hasAny = addr.addressLine1 || addr.city || addr.state || addr.postalCode;
        updates.business_address = hasAny ? addr : null;
      } else {
        updates.business_address = null;
      }
    }
    // Write-only secret: only overwritten when a non-empty value is sent.
    if (typeof payload.ghlApiKey === "string" && payload.ghlApiKey.trim()) {
      updates.ghl_api_key = payload.ghlApiKey.trim();
    }

    if (Object.keys(updates).length === 0) return json({ error: "Nothing to save." }, 400);
    updates.client_id = clientId;
    updates.updated_at = new Date().toISOString();

    const { error: upErr } = await admin
      .from("client_settings")
      .upsert(updates, { onConflict: "client_id" });
    if (upErr) return dbFail(req, clientId, "save your settings", upErr);
    return json({ ok: true });
  }

  // Designer branding save → writes client_configs (the public ?client= link).
  // Optionally uploads a logo image (base64) to the public 'branding' bucket.
  if (action === "save_branding") {
    const trimOrNull = (v: unknown, max = 300) => { const s = String(v ?? "").trim().slice(0, max); return s ? s : null; };
    // These two are applied as COLOURS on the tenant's public designer page (served via the
    // anon-callable get_config RPC), so they are the branding fields that actually reach a
    // stylesheet — and they were the only ones accepting an arbitrary string.
    //
    // NOT hex-only, deliberately: header_bg legitimately holds gradients today
    // (demo-sheds is on `linear-gradient(135deg, #1E293B 0%, #334155 100%)`), so a
    // `^#[0-9a-fA-F]{3,8}$` check — the one save_colors uses for swatches — would reject a
    // value already in production the next time that tenant saved. Instead this bounds the
    // CHARACTER SET to what a colour or gradient needs and refuses the characters that turn
    // a value into an injection: `;` (extra declarations), `{}` and `<>` (breaking out of a
    // style block), and url()/expression() (fetches and legacy script execution).
    const cssColorOrNull = (v: unknown): string | null | false => {
      const s = String(v ?? "").trim();
      if (!s) return null;
      if (s.length > 200) return false;
      if (!/^[#a-zA-Z0-9%.,()\s-]+$/.test(s)) return false;      // charset gate
      if (/url\s*\(|expression\s*\(|\/\*|@import/i.test(s)) return false;
      return s;
    };
    const updates: Record<string, unknown> = {};
    if ("companyName" in payload) updates.company_name = trimOrNull(payload.companyName, 200);
    if ("tagline" in payload)     updates.tagline      = trimOrNull(payload.tagline, 300);
    for (const [key, col] of [["accentColor", "accent_color"], ["headerBg", "header_bg"]] as const) {
      if (!(key in payload)) continue;
      const val = cssColorOrNull((payload as any)[key]);
      if (val === false) return json({ error: `${key === "accentColor" ? "Accent color" : "Header background"} must be a color like #D97706 or a gradient — it can't contain punctuation such as ; { } < >.` }, 400);
      updates[col] = val;
    }
    // BUILDING STYLES PER ROW (migration 232). Carolyn 2026-09-14 @7:10: a ninth style wrapped to a
    // second row of the designer's style bar; the bar now scrolls, and each builder picks how many
    // photos sit side by side. 5..8 because below 5 a tile is wider than the photo is worth and
    // above 8 the photos stop reading as buildings on a laptop — the column CHECK says the same, so
    // this message is the friendly copy of a refusal the database would make anyway.
    //
    // Checked BEFORE the logo upload below, so a refused value never leaves an orphan image in the
    // bucket. null / "" clears it (the designer falls back to 8). A boolean or "6 rows" is refused
    // rather than coerced: Number(true) is 1, and a quiet 1 would clamp to 5 on the designer.
    if ("stylesPerRow" in payload) {
      const raw = (payload as any).stylesPerRow;
      if (raw === null || raw === undefined || (typeof raw === "string" && raw.trim() === "")) {
        updates.styles_per_row = null;
      } else {
        const n = typeof raw === "number" ? raw
          : (typeof raw === "string" && /^\s*\d+\s*$/.test(raw)) ? Number(raw) : NaN;
        if (!Number.isInteger(n) || n < 5 || n > 8) return json({ error: "Styles per row must be a whole number from 5 to 8." }, 400);
        updates.styles_per_row = n;
      }
    }

    if (typeof payload.logoBase64 === "string" && payload.logoBase64.trim()) {
      const raw = payload.logoBase64.replace(/^data:[^;]+;base64,/, "");
      const ct = String(payload.logoContentType || "image/png");
      const EXT_BY_CT: Record<string, string> = { "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp", "image/gif": "gif" };
      const ext = EXT_BY_CT[ct];
      if (!ext) return json({ error: "Unsupported image type (use PNG, JPG, WEBP or GIF)." }, 400);
      let bytes: Uint8Array;
      try { bytes = Uint8Array.from(atob(raw), (c) => c.charCodeAt(0)); }
      catch { return json({ error: "Invalid logo data." }, 400); }
      if (bytes.length > 2_000_000) return json({ error: "Logo too large (max 2MB)." }, 400);
      const path = `${clientId}/logo-${crypto.randomUUID()}.${ext}`;
      const up = await admin.storage.from("branding").upload(path, bytes, { contentType: ct, upsert: true });
      if (up.error) return dbFail(req, clientId, "upload that logo", up.error);
      const { data: pub } = admin.storage.from("branding").getPublicUrl(path);
      updates.logo_url = pub.publicUrl;
    } else if ("logoUrl" in payload) {
      updates.logo_url = trimOrNull(payload.logoUrl); // allow setting/clearing by URL
    }

    if (Object.keys(updates).length === 0) return json({ error: "Nothing to save." }, 400);
    const { error: upErr } = await admin.from("client_configs").update(updates).eq("client_id", clientId);
    if (upErr) return dbFail(req, clientId, "save your branding", upErr);
    return json({ ok: true, logoUrl: updates.logo_url ?? null });
  }

  // Upload-only: store an image in the 'branding' bucket and return its public
  // URL (no DB write). Used by the "Upload image" buttons; the returned URL is
  // placed into a form field and persisted by the normal save action.
  if (action === "upload_logo") {
    if (typeof payload.logoBase64 !== "string" || !payload.logoBase64.trim()) return json({ error: "No logo data." }, 400);
    const raw = payload.logoBase64.replace(/^data:[^;]+;base64,/, "");
    const ct = String(payload.logoContentType || "image/png");
    const EXT_BY_CT: Record<string, string> = { "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp", "image/gif": "gif" };
    const ext = EXT_BY_CT[ct];
    if (!ext) return json({ error: "Unsupported image type (use PNG, JPG, WEBP or GIF)." }, 400);
    let bytes: Uint8Array;
    try { bytes = Uint8Array.from(atob(raw), (c) => c.charCodeAt(0)); }
    catch { return json({ error: "Invalid logo data." }, 400); }
    if (bytes.length > 2_000_000) return json({ error: "Logo too large (max 2MB)." }, 400);
    const prefix = payload.kind === "business" ? "biz-logo" : "logo";
    const path = `${clientId}/${prefix}-${crypto.randomUUID()}.${ext}`;
    const up = await admin.storage.from("branding").upload(path, bytes, { contentType: ct, upsert: true });
    if (up.error) return dbFail(req, clientId, "upload that logo", up.error);
    const { data: pub } = admin.storage.from("branding").getPublicUrl(path);
    return json({ ok: true, url: pub.publicUrl });
  }

  // Per-client catalog for the CSV/pricing UI (JWT-scoped to this tenant) — feeds
  // the downloadable template (styles × sizes + active items + current inclusions).
  if (action === "catalog") {
    const [styles, sizes, items, types, incl, lpRows, colorsRes, fixturesRes, csRamp, windowColorsRes, wallHeightsRes, claddingRes, insulationRes, electricalRes, elecItemsRes, foundationRes] = await Promise.all([
      // d3 / d3_photos (086): the per-style 3D spec, so the Structures tab can show which
      // styles are calibrated and the editor can reopen one for tuning.
      // updated_at (2026-09-14): the style's version, which the 3D editor sends back with its
      // next save so the late-save guard can refuse a stalled old copy (styleSaveGuard.ts).
      admin.from("building_styles").select("id, key, label, code, image_url, active, show_image_on_estimate, d3, d3_photos, d3_video_frames, model_url, model_status, model_uploaded_at, model_locked_at, model_meta, taxable, updated_at").eq("client_id", clientId).order("sort_order"),
      admin.from("building_sizes").select("id, style_id, label, width_ft, length_ft, base_price, active").eq("client_id", clientId).order("sort_order"),
      admin.from("client_layout_items").select("item_key, label_override, active, archived, internal_only, sort_order, taxable, depth_in, height_off_floor_in").eq("client_id", clientId).order("sort_order"),
      // wall_snap + the two dimension defaults (171): the Options grid only offers Depth and
      // Height off floor for wall-mounted items, and shows the master default where the tenant
      // has not overridden it.
      admin.from("layout_item_types").select("item_key, label, wall_snap, depth_in, height_off_floor_in"),
      admin.from("building_size_inclusions").select("size_id, item_key, included, qty").eq("client_id", clientId),
      // Default (style_id IS NULL) layout-item prices for the Layout Pricing tab.
      admin.from("layout_item_pricing").select("item_key, pricing_method, rate, image_url").eq("client_id", clientId).is("style_id", null),
      // Color palette for the Colors tab (paint = siding/trim; roof = shingle/metal).
      admin.from("colors").select("id, label, code, siding, trim, shingle, metal, door, door_rate, allow_custom, is_default, rate, pricing_method, hex, image_url, sort_order, active, taxable").eq("client_id", clientId).order("sort_order"),
      // Fixtures catalog (Options tab → Doors section; windows/ramps later via `category`).
      admin.from("fixture_items").select("id, category, name, plan_label, width_in, height_in, price, swing_in, swing_out, swing_default, op_right, op_left, op_double, op_slideup, op_default, color_mode, has_trim_color, fixed_color_id, window_color_ids, sill_in, sill_mode, door_style, image_url, show_image_on_estimate, sort_order, active, archived, internal_only, taxable").eq("client_id", clientId).order("sort_order"),
      // Ramp mode + simple-ramp config (client_settings, service-role only).
      admin.from("client_settings").select("ramp_mode, ramp_price, ramp_price_method, ramp_image_url, ramp_show_image, ramp_enabled, insulation_enabled").eq("client_id", clientId).maybeSingle(),
      // Window colors (116): the small per-client list every window fixture offers.
      admin.from("window_colors").select("id, label, hex, rate, is_default, sort_order, active").eq("client_id", clientId).order("sort_order"),
      // Wall-height upgrades (172), for the Options tab card. Per style, ordered by increase.
      admin.from("style_wall_heights").select("id, style_id, delta_in, rate_per_lf, taxable, active, sort_order, widths_ft, internal_only, build_on_site, bos_fee_basis, bos_fee_rate").eq("client_id", clientId).order("delta_in"),
      // Cladding offered per style (207). The card renders a FIXED four rows per style, so a
      // style with no rows is not "broken" — it is a style offering builder's standard only.
      admin.from("style_cladding").select("id, style_id, cladding_id, label_override, rate, basis, taxable, internal_only, active, sort_order").eq("client_id", clientId).order("sort_order"),
      // Insulation rates (177) for the Options tab matrix.
      admin.from("insulation_offerings").select("id, ins_type, area, rate_per_sqft, taxable, active, internal_only").eq("client_id", clientId),
      admin.from("electrical_settings").select("*").eq("client_id", clientId).maybeSingle(),
      admin.from("electrical_items").select("*").eq("client_id", clientId).order("sort_order").order("name"),
      // Foundation services (237). The card renders a FIXED four rows, so a tenant with no rows
      // is simply one offering no site work yet.
      admin.from("foundation_items").select("id, item_id, label_override, rate, basis, taxable, internal_only, active, sort_order").eq("client_id", clientId).order("sort_order"),
    ]);
    // csRamp is in this list. It used to be the one query of the nine whose error was not
    // checked, and its defaults are not neutral: `rs` would come back undefined and the
    // block below would fall through to `mode: "simple", enabled: true` — i.e. a tenant who
    // had deliberately turned ramps OFF would be shown, and would sell, as offering one.
    // Failing the request is right for a settings read; a half-true catalog is not.
    for (const r of [styles, sizes, items, types, incl, lpRows, colorsRes, fixturesRes, csRamp, windowColorsRes, wallHeightsRes, claddingRes, insulationRes, electricalRes, elecItemsRes, foundationRes]) if (r.error) return dbFail(req, clientId, "load your catalog", r.error);
    const labelByKey: Record<string, string> = {};
    const typeByKey: Record<string, any> = {};
    (types.data ?? []).forEach((t: any) => { labelByKey[t.item_key] = t.label; typeByKey[t.item_key] = t; });
    const itemList = (items.data ?? []).filter((i: any) => i.active || i.archived)
      .map((i: any) => {
        const t = typeByKey[i.item_key] || {};
        // Tenant override wins, master default fills in. null (not 0) means "not set", which is
        // what lets the grid show a blank rather than claiming a 0-inch shelf.
        const depth = i.depth_in != null ? i.depth_in : t.depth_in;
        const off = i.height_off_floor_in != null ? i.height_off_floor_in : t.height_off_floor_in;
        return { key: i.item_key, label: i.label_override || labelByKey[i.item_key] || i.item_key,
          archived: !!i.archived, internalOnly: !!i.internal_only, taxable: i.taxable !== false,
          wallSnap: !!t.wall_snap, depthIn: depth != null ? Number(depth) : null,
          heightOffFloorIn: off != null ? Number(off) : null };
      });
    const rs = csRamp.data;
    const rampSettings = { mode: (rs?.ramp_mode || "simple"), price: rs?.ramp_price ?? null, method: (rs?.ramp_price_method || "each"), imageUrl: rs?.ramp_image_url ?? null, showImage: rs?.ramp_show_image !== false, enabled: rs?.ramp_enabled !== false };
    // aiReady lets the editor DISABLE "Draft from photos" with a reason rather than letting a
    // builder click a button that can only fail: the Anthropic key is an edge secret, so the
    // browser has no other way to know whether the feature is configured.
    // WALLET, read here rather than only in portal-billing, because the calibration panel
    // has to show "$20 · balance $140" BEFORE the builder clicks. Learning the price from
    // a 402 after waiting thirty seconds for a generation is the worst possible ordering.
    // Fails soft to nulls: a wallet read that errors must not blank the whole catalog.
    let wallet: { balanceCents: number; heldCents: number; priceCents: number | null; meterActive: boolean } | null = null;
    try {
      const [acct, price] = await Promise.all([
        admin.from("wallet_accounts").select("balance_cents, held_cents").eq("client_id", clientId).maybeSingle(),
        admin.from("usage_prices").select("price_cents, active, visible").eq("kind", "video_3d_generation").maybeSingle(),
      ]);
      wallet = {
        balanceCents: Number(acct.data?.balance_cents ?? 0),
        heldCents: Number(acct.data?.held_cents ?? 0),
        // Redacted when visible is false, the same posture portal-billing takes on
        // billing_plans.price_cents — the projection and the revoke are both load-bearing.
        priceCents: price.data && price.data.visible !== false ? Number(price.data.price_cents) : null,
        meterActive: Boolean(price.data?.active),
      };
    } catch (_) { wallet = null; }

    return json({ ok: true, clientId, styles: styles.data, sizes: sizes.data, items: itemList, inclusions: incl.data, layoutPricing: lpRows.data ?? [], colors: colorsRes.data ?? [], fixtures: fixturesRes.data ?? [], windowColors: windowColorsRes.data ?? [], wallHeights: wallHeightsRes.data ?? [], cladding: claddingRes.data ?? [], insulation: insulationRes.data ?? [],
      // Null for a tenant who has never opened the card — the portal falls back to the same
      // defaults the table declares, so the form is never blank.
      electrical: electricalRes.data ?? null,
      electricalItems: elecItemsRes.data ?? [],
      foundation: foundationRes.data ?? [],
      insulationEnabled: (csRamp.data as { insulation_enabled?: boolean } | null)?.insulation_enabled === true, rampSettings, aiReady: Boolean(Deno.env.get("ANTHROPIC_API_KEY")), wallet });
  }

  // CSV pricing + inclusion import (client self-serve). clientId is JWT-resolved,
  // never from the body, so an owner can only ever import into their own tenant.
  if (action === "import_pricing_csv") {
    if (!Array.isArray(payload.rows)) return json({ error: "rows[] required" }, 400);
    { const e = tooMany(payload.rows, "rows"); if (e) return json({ error: e }, 400); }
    try {
      const r = await importPricingRows(admin, clientId, payload.rows);
      return json({ ok: true, ...r });
    } catch (e) { return dbFail(req, clientId, "import that pricing sheet", e); }
  }

  // ══ Real-Time Pricing (migration 152) ══════════════════════════════════════════════
  // Carolyn 2026-08-27, handing over the 2015 Sterling Supply workbook: material costs in
  // one place, a bill of materials per size, ordered overhead lines, and the computed
  // price lands in building_sizes.base_price — the ONE live column every estimate reader
  // already consumes. All math lives in SQL (rtp_compute_prices); these branches only
  // move rows and re-apply. See the migration header for the model.
  //
  // ENTITLEMENT, server-side. on_demand_pricing is PAY-ONLY (portal-billing) and has been
  // on sale since migration 124, so a direct POST from a tenant who never bought it must
  // 403 here regardless of what the browser hides. Operators are checked the same way since
  // 2026-09-15 (see the note above the row scope). Errors reading billing fail CLOSED — a
  // paid gate that fails open is no gate (the wallet's posture).
  const RTP_ACTIONS = new Set(["rtp_data", "save_rtp_material", "delete_rtp_material", "reorder_rtp_materials", "save_rtp_bom", "save_rtp_overhead", "import_rtp_workbook", "set_rtp_enabled"]);
  if (RTP_ACTIONS.has(action)) {
    let paid = false;
    try { paid = await hasPaidFeature(admin, clientId, "on_demand_pricing"); }
    catch (e) { return dbFail(req, clientId, "check your Real-Time Pricing subscription", e); }
    if (!paid) {
      // rtp_data answers softly so the settings card can render its teaser state from the
      // same call it would otherwise load data with; the write actions refuse loudly.
      if (action === "rtp_data") return json({ ok: true, entitled: false });
      return json({ error: "Real-Time Pricing is not part of your subscription — add it under Settings → Billing." }, 403);
    }
  }
  // ENTITLEMENT, server-side, for the built-in CRM. Same posture as the RTP gate above and
  // the same reason: featureOn() in the browser is presentation, not enforcement, so a direct
  // POST must 403 here. crm is PAY-ONLY (portal-billing PAID_ONLY_FEATURES) and the Suite
  // confers it (BUNDLE_FEATURES) — hasPaidFeature resolves both, so a Suite subscriber passes
  // without this list knowing anything about bundles.
  //
  // WHY ONE GUARD RATHER THAN TWELVE: every crm_* action below reads or writes crm_contacts,
  // crm_notes, crm_activities or the message threads hanging off them, and none of that is
  // reachable any other way — the browser never does sb.from("crm_contacts") directly (see
  // portal/02-sales.jsx, "NEVER a direct sb.from(...).update()"). So this one choke point is
  // the whole paid surface, and a new crm_* action added later is gated by NAME PREFIX
  // without anyone remembering to come back here. That is deliberate: the alternative, a
  // hand-maintained Set like RTP_ACTIONS, is exactly the list that gets forgotten.
  //
  // NOT gated: `contact_activity`. It reads designs/design_versions by short_code — design
  // history the free Pipeline list already shows — and is not CRM data. Gating it would take
  // away something that was never part of this sale.
  //
  // ⚠️ NOR is `crm_record` when kind === "design", and that exception is load-bearing. The
  // crm_ prefix is a lie about that one action: CrmRecord serves BOTH a contact record and a
  // DESIGN record, and the design record is what opens when someone clicks a row in the free
  // Pipeline list (11-shell.jsx routes it to d-<code>). It is the design data a Simple Layout
  // subscriber already pays for, wearing a CRM-shaped action name. Gating it would have
  // locked the free list's own rows behind the CRM, which is neither what was sold nor what
  // Carolyn asked for ("they only get the list view" — the list still has to WORK).
  //
  // ⚠️⚠️ THE EXEMPTION IS FOR THE DESIGN, NOT FOR THE DOOR. That paragraph used to say the
  // branch "reads `designs` only — no crm_contacts, no notes, no threads", and that was
  // simply not true of the code: the design branch reads the linked crm_contacts row and
  // builds the CONTACT-scoped feed (notes, email and text threads, uploaded files) beside
  // it. So the one action deliberately let through without the subscription was handing over
  // the subscription's data. `crmPaid` below is therefore RESOLVED for the exempt action too
  // and carried into the branch, which serves the design half and withholds the contact half
  // — same shape as the per-area CONTACT SCOPE check that sits next to it.
  const crmGated = action.startsWith("crm_") &&
    !(action === "crm_record" && payload?.kind === "design");
  // Default true so every non-CRM action keeps today's behaviour without paying for a
  // billing read it does not need. Operators are resolved like everyone else (2026-09-15).
  let crmPaid = true;
  if (crmGated || action === "crm_record") {
    try { crmPaid = await hasPaidFeature(admin, clientId, "crm"); }
    catch (e) { return dbFail(req, clientId, "check your CRM subscription", e); }
    if (crmGated && !crmPaid) return json({ error: "The built-in CRM is not part of your subscription - add it under Settings -> Billing." }, 403);
  }

  // ENTITLEMENT, server-side, for QuickBooks sync. Third instance of the RTP posture above
  // and the last of the pay-only features to get one: quickbooks_sync is PAY-ONLY
  // (portal-billing PAID_ONLY_FEATURES) and the Suite confers it, the browser hides the tab
  // and the Settings card, and until now NOTHING on the server asked — so connecting a
  // company, mapping items, testing and retrying all worked for a tenant who never bought it
  // or whose subscription lapsed. A hidden tab is presentation; this is the enforcement.
  //
  // A HAND-KEPT SET, not the crm_ name-prefix trick, because the action names here do not
  // share one: `list_item_map` and `list_qbo_items` carry no qbo_ prefix. preflight's
  // gate cross-check catches an action missing from GATES, not one missing from here — so
  // the list and the GATES block above are kept adjacent on purpose.
  //
  // ⛔ disconnect_qbo IS DELIBERATELY ABSENT. Revoking our access to a builder's books is
  // the one QuickBooks verb that must work when the subscription does not: a lapsed tenant
  // has to be able to cut us off, and refusing that would leave live Intuit tokens they
  // cannot revoke from our side of the connection.
  const QBO_ACTIONS = new Set(["qbo_status", "qbo_pending", "list_item_map", "list_qbo_items", "save_item_map", "qbo_test", "retry_qbo_push"]);
  // Resolved at most once per request and shared with the invoice-push call sites further
  // down, which are reached through send_invoice rather than through a qbo_* action.
  let qboPaidCache: boolean | null = null;
  const qboEntitled = async (): Promise<boolean> => {
    if (qboPaidCache === null) qboPaidCache = await hasPaidFeature(admin, clientId, "quickbooks_sync");
    return qboPaidCache;
  };
  // The invoice PUSH is reached through send_invoice rather than a qbo_* action, so it asks
  // the same question at its own two call sites. This one never throws: by the time those run
  // the invoice is issued and the customer has been emailed, so a billing-read hiccup must
  // skip the bookkeeping push — which Settings → QuickBooks → Retry can re-run — rather than
  // fail a send that has already happened. Skipping is still the fail-CLOSED direction.
  const qboPushAllowed = async (): Promise<boolean> => {
    try {
      return await qboEntitled();
    } catch (e) {
      logEdgeError({
        fn: "portal-settings", req, clientId, code: "qbo_entitlement_unreadable",
        message: `QuickBooks entitlement check failed; invoice push skipped: ${(e as Error)?.message ?? ""}`,
      }).catch(() => {});
      return false;
    }
  };
  if (QBO_ACTIONS.has(action)) {
    let paid = false;
    try { paid = await qboEntitled(); }
    catch (e) { return dbFail(req, clientId, "check your QuickBooks subscription", e); }
    if (!paid) {
      // qbo_status answers SOFTLY, the way rtp_data does: the Settings → QuickBooks card
      // loads its own state from this call, so a 403 would blank the tab instead of showing
      // the not-connected teaser the tenant is meant to see. Reported as a real
      // not-connected state (`connected: false`) so a client that has never heard of
      // `entitled` renders exactly that.
      if (action === "qbo_status") {
        return json({
          clientId, entitled: false, oauthReady: qboOauthReady(),
          connected: false, companyName: null, realmIdMasked: null, connectedAt: null,
          broken: false, brokenReason: null, refreshTokenExpiresAt: null,
          disconnectReason: null, mappedCount: 0,
        });
      }
      return json({ error: "QuickBooks sync is not part of your subscription — add it under Settings → Billing." }, 403);
    }
  }

  // Re-apply after any RTP mutation: the SQL function no-ops unless the toggle is ON, and
  // recompute over a tenant's sizes is trivial, so the choke point that already gates the
  // write is also where prices stay current. Fails soft — the edit succeeded; a re-price
  // hiccup must not report it as failed. The next mutation (or toggle) re-applies.
  const rtpApply = async (): Promise<number> => {
    try {
      const { data, error } = await admin.rpc("rtp_apply", { p_client_id: clientId });
      if (error) throw error;
      return Number(data) || 0;
    } catch (e) {
      await logEdgeError({ fn: "portal-settings", req, clientId, code: "rtp_apply_failed", message: (e as Error)?.message ?? "" });
      return 0;
    }
  };

  if (action === "rtp_data") {
    const [mats, bom, ovh, cs, prev] = await Promise.all([
      admin.from("rtp_materials").select("id, category, name, unit_cost, sort_order, active").eq("client_id", clientId).order("sort_order").order("created_at"),
      admin.from("rtp_bom_lines").select("id, size_id, material_id, section, qty, sort_order").eq("client_id", clientId).order("sort_order"),
      admin.from("rtp_overhead_lines").select("id, label, kind, value, sort_order, active").eq("client_id", clientId).order("sort_order").order("created_at"),
      admin.from("client_settings").select("rtp_enabled").eq("client_id", clientId).maybeSingle(),
      admin.rpc("rtp_compute_prices", { p_client_id: clientId }),
    ]);
    for (const r of [mats, bom, ovh, cs, prev]) if (r.error) return dbFail(req, clientId, "load your real-time pricing", r.error);
    return json({
      ok: true, entitled: true,
      enabled: Boolean(cs.data?.rtp_enabled),
      materials: mats.data ?? [], bomLines: bom.data ?? [], overhead: ovh.data ?? [],
      preview: prev.data ?? [],
    });
  }

  if (action === "save_rtp_material") {
    const name = String(payload.name ?? "").trim();
    const category = String(payload.category ?? "").trim();
    const unitCost = Number(payload.unitCost);
    if (!name) return json({ error: "Material name is required." }, 400);
    if (!Number.isFinite(unitCost) || unitCost < 0) return json({ error: `Invalid cost "${payload.unitCost}".` }, 400);
    const patch: Record<string, unknown> = { category, name, unit_cost: unitCost, updated_at: new Date().toISOString() };
    if (payload.sortOrder != null && Number.isFinite(Number(payload.sortOrder))) patch.sort_order = Number(payload.sortOrder);
    if (typeof payload.active === "boolean") patch.active = payload.active;
    const res = payload.id
      ? await admin.from("rtp_materials").update(patch).eq("id", String(payload.id)).eq("client_id", clientId).select("id").maybeSingle()
      : await admin.from("rtp_materials").insert({ client_id: clientId, ...patch }).select("id").maybeSingle();
    if (res.error) {
      // The one expected failure: unique (client_id, name). Name it rather than 500ing.
      if ((res.error as { code?: string }).code === "23505") return json({ error: `You already have a material named "${name}".` }, 400);
      return dbFail(req, clientId, "save that material", res.error);
    }
    const applied = await rtpApply();
    return json({ ok: true, id: res.data?.id ?? payload.id, applied });
  }

  if (action === "delete_rtp_material") {
    // Archive, never delete: BOM lines reference materials (on delete restrict), and a
    // vanished material would silently change every price that summed it.
    if (!payload.id) return json({ error: "id required" }, 400);
    const res = await admin.from("rtp_materials").update({ active: false, updated_at: new Date().toISOString() })
      .eq("id", String(payload.id)).eq("client_id", clientId);
    if (res.error) return dbFail(req, clientId, "archive that material", res.error);
    const applied = await rtpApply();
    return json({ ok: true, applied });
  }

  if (action === "reorder_rtp_materials") {
    if (!Array.isArray(payload.ids)) return json({ error: "ids[] required" }, 400);
    { const e = tooMany(payload.ids, "ids"); if (e) return json({ error: e }, 400); }
    for (let i = 0; i < payload.ids.length; i++) {
      const res = await admin.from("rtp_materials").update({ sort_order: i })
        .eq("id", String(payload.ids[i])).eq("client_id", clientId);
      if (res.error) return dbFail(req, clientId, "reorder your materials", res.error);
    }
    return json({ ok: true });
  }

  if (action === "save_rtp_bom") {
    // FULL REPLACE of one size's bill of materials — the editor always shows and saves the
    // whole list for the size it has open, so a partial write has nothing to express.
    const sizeId = String(payload.sizeId ?? "");
    if (!sizeId) return json({ error: "sizeId required" }, 400);
    if (!Array.isArray(payload.lines)) return json({ error: "lines[] required" }, 400);
    { const e = tooMany(payload.lines, "lines"); if (e) return json({ error: e }, 400); }
    const sz = await admin.from("building_sizes").select("id").eq("id", sizeId).eq("client_id", clientId).maybeSingle();
    if (sz.error) return dbFail(req, clientId, "check that size", sz.error);
    if (!sz.data) return json({ error: "That size does not exist in your catalog." }, 400);
    const matsRes = await admin.from("rtp_materials").select("id").eq("client_id", clientId);
    if (matsRes.error) return dbFail(req, clientId, "load your materials", matsRes.error);
    const validMat = new Set((matsRes.data ?? []).map((m: { id: string }) => m.id));
    const SECTIONS = new Set(["floor", "walls", "roof", "interior", "other"]);
    const rows: Record<string, unknown>[] = []; const skipped: string[] = [];
    const seen = new Set<string>();
    for (const [i, ln] of (payload.lines as unknown[]).entries()) {
      const l = ln as { materialId?: unknown; section?: unknown; qty?: unknown };
      const materialId = String(l.materialId ?? "");
      const section = String(l.section ?? "other");
      const qty = Number(l.qty);
      if (!validMat.has(materialId)) { skipped.push(`line ${i + 1}: unknown material`); continue; }
      if (!SECTIONS.has(section)) { skipped.push(`line ${i + 1}: unknown section "${section}"`); continue; }
      if (!Number.isFinite(qty) || qty < 0) { skipped.push(`line ${i + 1}: invalid quantity "${l.qty}"`); continue; }
      if (qty === 0) continue; // a zero-quantity line is a deletion, exactly like the inclusions import
      const key = `${materialId}|${section}`;
      if (seen.has(key)) { skipped.push(`line ${i + 1}: duplicate material+section`); continue; }
      seen.add(key);
      rows.push({ client_id: clientId, size_id: sizeId, material_id: materialId, section, qty, sort_order: i });
    }
    const del = await admin.from("rtp_bom_lines").delete().eq("size_id", sizeId).eq("client_id", clientId);
    if (del.error) return dbFail(req, clientId, "replace that bill of materials", del.error);
    if (rows.length) {
      const ins = await admin.from("rtp_bom_lines").insert(rows);
      if (ins.error) return dbFail(req, clientId, "save that bill of materials", ins.error);
    }
    const applied = await rtpApply();
    return json({ ok: true, saved: rows.length, skipped, applied });
  }

  if (action === "save_rtp_overhead") {
    // FULL REPLACE, ordered — the order IS the formula (multipliers apply in sequence).
    if (!Array.isArray(payload.lines)) return json({ error: "lines[] required" }, 400);
    { const e = tooMany(payload.lines, "lines"); if (e) return json({ error: e }, 400); }
    const KINDS = new Set(["multiplier", "percent_of_price", "flat"]);
    const rows: Record<string, unknown>[] = []; const skipped: string[] = [];
    for (const [i, ln] of (payload.lines as unknown[]).entries()) {
      const l = ln as { label?: unknown; kind?: unknown; value?: unknown; active?: unknown };
      const label = String(l.label ?? "").trim();
      const kind = String(l.kind ?? "");
      const value = Number(l.value);
      if (!label) { skipped.push(`line ${i + 1}: label required`); continue; }
      if (!KINDS.has(kind)) { skipped.push(`line ${i + 1}: unknown kind "${l.kind}"`); continue; }
      if (!Number.isFinite(value) || value < 0) { skipped.push(`line ${i + 1}: invalid value "${l.value}"`); continue; }
      rows.push({ client_id: clientId, label, kind, value, sort_order: i, active: l.active !== false });
    }
    const del = await admin.from("rtp_overhead_lines").delete().eq("client_id", clientId);
    if (del.error) return dbFail(req, clientId, "replace your overhead lines", del.error);
    if (rows.length) {
      const ins = await admin.from("rtp_overhead_lines").insert(rows);
      if (ins.error) return dbFail(req, clientId, "save your overhead lines", ins.error);
    }
    const applied = await rtpApply();
    return json({ ok: true, saved: rows.length, skipped, applied });
  }

  if (action === "import_rtp_workbook") {
    // The browser parses the workbook into structured JSON; THIS is the trust boundary.
    // Materials upsert by name (new names auto-create — a quarterly cost update arrives as
    // the same sheet with new numbers). BOM blocks replace per size PRESENT IN THE UPLOAD
    // (a partial workbook touches only what it carries). Sizes resolve against the
    // existing catalog by style + width x length and are NEVER created here — size
    // lifecycle belongs to the pricing sheet (importPricingRows), one lifecycle per thing.
    const materials = Array.isArray(payload.materials) ? payload.materials : [];
    const bom = Array.isArray(payload.bom) ? payload.bom : [];
    const overhead = Array.isArray(payload.overhead) ? payload.overhead : null;
    { const e = tooMany(materials, "materials") ?? tooMany(bom, "bom"); if (e) return json({ error: e }, 400); }
    const skipped: string[] = [];
    let matsSaved = 0, sizesReplaced = 0;

    // ── Materials: upsert by (client_id, name) ──
    const exMats = await admin.from("rtp_materials").select("id, name").eq("client_id", clientId);
    if (exMats.error) return dbFail(req, clientId, "load your materials", exMats.error);
    const idByName = new Map<string, string>((exMats.data ?? []).map((m: { id: string; name: string }) => [m.name.toLowerCase(), m.id]));
    for (const raw of materials) {
      const m = raw as { category?: unknown; name?: unknown; unitCost?: unknown };
      const name = String(m.name ?? "").trim();
      const category = String(m.category ?? "").trim();
      const unitCost = Number(m.unitCost);
      if (!name) continue;
      if (!Number.isFinite(unitCost) || unitCost < 0) { skipped.push(`material "${name}": invalid cost "${m.unitCost}"`); continue; }
      const existingId = idByName.get(name.toLowerCase());
      const res = existingId
        ? await admin.from("rtp_materials").update({ category, unit_cost: unitCost, active: true, updated_at: new Date().toISOString() }).eq("id", existingId).select("id").maybeSingle()
        : await admin.from("rtp_materials").insert({ client_id: clientId, category, name, unit_cost: unitCost, sort_order: idByName.size + matsSaved }).select("id").maybeSingle();
      if (res.error) { skipped.push(`material "${name}": ${res.error.message}`); continue; }
      if (!existingId && res.data?.id) idByName.set(name.toLowerCase(), res.data.id);
      matsSaved++;
    }

    // ── Sizes: resolve style by label OR key (importPricingRows' matching), then dims ──
    const [stylesRes, sizesRes] = await Promise.all([
      admin.from("building_styles").select("id, key, label").eq("client_id", clientId),
      admin.from("building_sizes").select("id, style_id, width_ft, length_ft").eq("client_id", clientId),
    ]);
    if (stylesRes.error) return dbFail(req, clientId, "load your styles", stylesRes.error);
    if (sizesRes.error) return dbFail(req, clientId, "load your sizes", sizesRes.error);
    const styleByName = new Map<string, string>();
    for (const s of stylesRes.data ?? []) { styleByName.set(s.label.toLowerCase(), s.id); styleByName.set(s.key.toLowerCase(), s.id); }
    const sizeByDims = new Map<string, string>((sizesRes.data ?? []).map((z: { id: string; style_id: string; width_ft: number; length_ft: number }) => [`${z.style_id}|${Number(z.width_ft)}|${Number(z.length_ft)}`, z.id]));
    const SECTIONS = new Set(["floor", "walls", "roof", "interior", "other"]);

    for (const raw of bom) {
      const b = raw as { style?: unknown; width?: unknown; length?: unknown; lines?: unknown };
      const styleName = String(b.style ?? "").trim();
      const width = Number(b.width), length = Number(b.length);
      const styleId = styleByName.get(styleName.toLowerCase());
      if (!styleId) { skipped.push(`${styleName} ${b.width}x${b.length}: unknown style`); continue; }
      const sizeId = sizeByDims.get(`${styleId}|${width}|${length}`);
      if (!sizeId) { skipped.push(`${styleName} ${width}x${length}: no such size in your catalog — add it on the pricing sheet first`); continue; }
      const lines = Array.isArray(b.lines) ? b.lines : [];
      { const e = tooMany(lines, "lines"); if (e) { skipped.push(`${styleName} ${width}x${length}: ${e}`); continue; } }
      const rows: Record<string, unknown>[] = [];
      const seen = new Set<string>();
      for (const [i, ln] of (lines as unknown[]).entries()) {
        const l = ln as { material?: unknown; section?: unknown; qty?: unknown };
        const matName = String(l.material ?? "").trim();
        const section = SECTIONS.has(String(l.section ?? "")) ? String(l.section) : "other";
        const qty = Number(l.qty);
        const materialId = idByName.get(matName.toLowerCase());
        if (!materialId) { if (matName) skipped.push(`${styleName} ${width}x${length}: material "${matName}" is not on the Materials sheet`); continue; }
        if (!Number.isFinite(qty) || qty <= 0) continue; // blank/zero qty = not used on this building
        const key = `${materialId}|${section}`;
        if (seen.has(key)) { skipped.push(`${styleName} ${width}x${length}: "${matName}" listed twice under ${section}`); continue; }
        seen.add(key);
        rows.push({ client_id: clientId, size_id: sizeId, material_id: materialId, section, qty, sort_order: i });
      }
      const del = await admin.from("rtp_bom_lines").delete().eq("size_id", sizeId).eq("client_id", clientId);
      if (del.error) { skipped.push(`${styleName} ${width}x${length}: ${del.error.message}`); continue; }
      if (rows.length) {
        const ins = await admin.from("rtp_bom_lines").insert(rows);
        if (ins.error) { skipped.push(`${styleName} ${width}x${length}: ${ins.error.message}`); continue; }
      }
      sizesReplaced++;
    }

    // ── Overhead: replace only when the sheet is present in the upload ──
    if (overhead) {
      const KINDS = new Set(["multiplier", "percent_of_price", "flat"]);
      const rows: Record<string, unknown>[] = [];
      for (const [i, ln] of (overhead as unknown[]).entries()) {
        const l = ln as { label?: unknown; kind?: unknown; value?: unknown };
        const label = String(l.label ?? "").trim();
        const kind = String(l.kind ?? "");
        const value = Number(l.value);
        if (!label || !KINDS.has(kind) || !Number.isFinite(value) || value < 0) { skipped.push(`overhead line ${i + 1}: invalid`); continue; }
        rows.push({ client_id: clientId, label, kind, value, sort_order: i, active: true });
      }
      const del = await admin.from("rtp_overhead_lines").delete().eq("client_id", clientId);
      if (del.error) return dbFail(req, clientId, "replace your overhead lines", del.error);
      if (rows.length) {
        const ins = await admin.from("rtp_overhead_lines").insert(rows);
        if (ins.error) return dbFail(req, clientId, "save your overhead lines", ins.error);
      }
    }

    const applied = await rtpApply();
    return json({ ok: true, materialsSaved: matsSaved, sizesReplaced, skipped, applied });
  }

  if (action === "set_rtp_enabled") {
    // The atomic swap — backs up manual prices on the way ON, restores them on the way
    // OFF, applies computed prices in between. All inside one SQL function so no failure
    // can leave half a price book. Durable audit row: this is a mass rewrite of the
    // tenant's price book, exactly the kind of event someone asks about a month later.
    const on = Boolean(payload.on);
    const { error } = await admin.rpc("rtp_set_enabled", { p_client_id: clientId, p_on: on });
    if (error) return dbFail(req, clientId, on ? "turn real-time pricing on" : "turn real-time pricing off", error);
    await auditStrict("portal_rtp_toggle", 1, `rtp_enabled=${on}`);
    return json({ ok: true, enabled: on });
  }

  // Layout-item pricing (per placeable: doors, windows, workbench, loft, ramp …). Saves
  // only DEFAULT rows (style_id IS NULL); per-style overrides stay DB-managed and are
  // still honored at estimate time. Manual upsert (not PostgREST onConflict) because the
  // unique index is partial — (client_id, item_key) WHERE style_id IS NULL — and can't be
  // inferred by the upsert API. clientId is JWT-resolved, never trusted from the body.
  if (action === "save_layout_pricing") {
    if (!Array.isArray(payload.rows)) return json({ error: "rows[] required" }, 400);
    { const e = tooMany(payload.rows, "rows"); if (e) return json({ error: e }, 400); }
    const ALLOWED_METHODS = new Set(["each", "lineal_ft", "sqft_option", "sqft_building", "perimeter_building", "pct_building_price", "pct_estimate_total"]);
    const itemsRes = await admin.from("client_layout_items").select("item_key, active").eq("client_id", clientId);
    if (itemsRes.error) return dbFail(req, clientId, "load your option list", itemsRes.error);
    const validKeys = new Set((itemsRes.data ?? []).filter((i: any) => i.active).map((i: any) => i.item_key));
    const exRes = await admin.from("layout_item_pricing").select("id, item_key").eq("client_id", clientId).is("style_id", null);
    if (exRes.error) return dbFail(req, clientId, "load your current option prices", exRes.error);
    const idByKey = new Map<string, string>();
    for (const r of exRes.data ?? []) idByKey.set(r.item_key, r.id);
    let saved = 0; const skipped: string[] = [];
    for (const row of payload.rows) {
      const itemKey = String(row?.item_key ?? "").trim();
      const method = String(row?.pricing_method ?? "").trim();
      const rate = Number(row?.rate);
      if (!itemKey) continue;
      if (!validKeys.has(itemKey)) { skipped.push(`${itemKey}: not an enabled item`); continue; }
      if (!ALLOWED_METHODS.has(method)) { skipped.push(`${itemKey}: invalid method "${method}"`); continue; }
      if (!Number.isFinite(rate) || rate < 0) { skipped.push(`${itemKey}: invalid rate "${row?.rate}"`); continue; }
      // Optional per-item image (shown on the estimate line for this product). Only written
      // when the row carries an imageUrl field, so a save from an older client never blanks
      // it; an explicit empty string clears it.
      const hasImg = Object.prototype.hasOwnProperty.call(row, "imageUrl");
      const imageUrl = hasImg ? (String(row.imageUrl ?? "").trim() || null) : undefined;
      const existingId = idByKey.get(itemKey);
      const patch: Record<string, unknown> = { pricing_method: method, rate };
      if (hasImg) patch.image_url = imageUrl;
      const res = existingId
        ? await admin.from("layout_item_pricing").update(patch).eq("id", existingId)
        : await admin.from("layout_item_pricing").insert({ client_id: clientId, item_key: itemKey, style_id: null, ...patch });
      if (res.error) { skipped.push(`${itemKey}: ${res.error.message}`); continue; }
      // Dimensions for a wall-mounted item (171): depth of the drawn footprint, and how far off
      // the floor it hangs — the number that lets a shelf sit above a workbench without the two
      // colliding. They live on client_layout_items, not layout_item_pricing, so they are
      // written separately and ONLY when the row carries the field: presence-guarded exactly
      // like imageUrl above, so a save from an older client can never blank a builder's setup.
      // An explicit empty string clears the override and falls back to the master default.
      const dims: Record<string, unknown> = {};
      let dimBad = "";
      for (const [field, col] of [["depthIn", "depth_in"], ["heightOffFloorIn", "height_off_floor_in"]] as [string, string][]) {
        if (!Object.prototype.hasOwnProperty.call(row, field)) continue;
        const raw = String((row as Record<string, unknown>)[field] ?? "").trim();
        if (raw === "") { dims[col] = null; continue; }
        const n = Number(raw);
        // Refuse, never coerce — the same posture as the rate above. A silently-zeroed depth
        // would draw a zero-thickness shelf on the customer's plan.
        if (!Number.isFinite(n) || n < 0) { dimBad = `${itemKey}: invalid ${field} "${raw}"`; break; }
        dims[col] = n;
      }
      if (dimBad) { skipped.push(dimBad); continue; }
      if (Object.keys(dims).length) {
        const dRes = await admin.from("client_layout_items").update(dims).eq("client_id", clientId).eq("item_key", itemKey);
        if (dRes.error) { skipped.push(`${itemKey}: ${dRes.error.message}`); continue; }
      }
      saved++;
    }
    return json({ ok: true, saved, skipped });
  }

  // Verify the GHL Location ID + API key against GoHighLevel, then save ONLY if they
  // are valid. Location/key fall back to the stored values when the field is left blank
  // (so an owner can re-verify without re-typing the secret). Also reports whether the
  // location has users (required for estimates) and products (needed for pricing).
  if (action === "verify_save_ghl") {
    const trim = (v: unknown) => String(v ?? "").trim();
    const { data: cur, error: curErr } = await admin
      .from("client_settings")
      .select("ghl_location_id, ghl_api_key")
      .eq("client_id", clientId)
      .maybeSingle();
    if (curErr) return dbFail(req, clientId, "read your saved CRM credentials", curErr);

    const locationId = trim(payload.ghlLocationId) || (cur?.ghl_location_id ?? "");
    const apiKey = trim(payload.ghlApiKey) || (cur?.ghl_api_key ?? "");
    if (!locationId || !apiKey) {
      return json({ error: "Enter both a GHL Location ID and an API key to verify the connection." }, 400);
    }
    // Guard against browser autofill dropping the login email into the Location ID field.
    if (locationId.includes("@") || /\s/.test(locationId)) {
      return json({ error: `That GHL Location ID looks wrong ("${locationId}") — it should be the sub-account location id like sp58arigVfqozsJSPe1z, not an email. This is usually browser autofill: clear the field and paste the real Location ID.` }, 400);
    }

    const ghlHeaders = {
      "Version": "2021-07-28",
      "Authorization": `Bearer ${apiKey}`,
      "Accept": "application/json",
    };
    // Location-scoped read: 200 ⇒ the key is valid for this location; 401/403 ⇒ wrong key/location.
    let prodStatus = 0, prodOk = false, prodBody = "";
    try {
      const r = await fetch(`https://services.leadconnectorhq.com/products/?locationId=${encodeURIComponent(locationId)}`, { headers: ghlHeaders });
      prodStatus = r.status; prodOk = r.ok; prodBody = (await r.text()).slice(0, 600);
    } catch (e) {
      return json({ error: `Couldn't reach GoHighLevel to verify: ${(e as Error).message}` }, 502);
    }
    if (!prodOk) {
      // An authored hint, never GoHighLevel's raw body. This used to paste 600 characters
      // of a third party's response straight into the browser — arbitrary text we neither
      // author nor control, on a screen a builder is looking at. The body is still captured
      // for diagnosis, it just goes to app_errors (server-side) instead of the response.
      // This is not a step back from c38b5aa: that change was about surfacing the reasons
      // THIS function writes rather than swallowing them behind "non-2xx", and a sentence we
      // wrote is more actionable to a builder than GHL's JSON either way.
      const hint = prodStatus === 401 || prodStatus === 403
        ? "The API key is wrong, expired, or not authorized for this Location ID."
        : prodStatus === 404
          ? "That Location ID doesn't exist on this GoHighLevel account."
          : prodStatus >= 500
            ? "GoHighLevel is having trouble right now — try again in a few minutes."
            : "GoHighLevel rejected the request. Check the Location ID and API key are from the same sub-account.";
      // Severity: anything below 500 is the CRM refusing what the builder just typed (a wrong
      // key, a wrong Location ID, a key without that location's scope), which the hint above
      // already explains, so it files as info. Only a vendor 5xx is a fault.
      logEdgeError({
        fn: "portal-settings", req, clientId, code: prodStatus,
        message: `verify_save_ghl: GoHighLevel rejected the products probe (HTTP ${prodStatus})`,
        context: { action: "verify_save_ghl", body: prodBody.slice(0, 600) },
        severity: prodStatus >= 500 ? "error" : "info",
      }).catch(() => {});
      return json({ error: `Verification failed (HTTP ${prodStatus}). ${hint}` }, 400);
    }

    // Estimate-readiness signals (non-blocking).
    let hasProducts = false, hasUsers = false;
    try { const pj = JSON.parse(prodBody || "{}"); hasProducts = Array.isArray(pj?.products) && pj.products.length > 0; } catch { /* ignore */ }
    try {
      const ur = await fetch(`https://services.leadconnectorhq.com/users/?locationId=${encodeURIComponent(locationId)}`, { headers: ghlHeaders });
      if (ur.ok) { const uj = await ur.json(); hasUsers = Array.isArray(uj?.users) && uj.users.length > 0; }
    } catch { /* non-fatal */ }

    // Verified → save.
    const updates: Record<string, unknown> = {
      client_id: clientId,
      ghl_location_id: locationId,
      ghl_api_key: apiKey,
      updated_at: new Date().toISOString(),
    };
    if ("ghlPipelineId" in payload) updates.ghl_pipeline_id = trim(payload.ghlPipelineId) || null;
    if ("ghlStageSendQuoteId" in payload) updates.ghl_stage_send_quote_id = trim(payload.ghlStageSendQuoteId) || null;
    if ("ghlStageAcceptedId" in payload) updates.ghl_stage_accepted_id = trim(payload.ghlStageAcceptedId) || null;
    if ("ghlStageInvoicedId" in payload) updates.ghl_stage_invoiced_id = trim(payload.ghlStageInvoicedId) || null;
    if ("ghlStageDeliveredId" in payload) updates.ghl_stage_delivered_id = trim(payload.ghlStageDeliveredId) || null;
    const { error: upErr } = await admin.from("client_settings").upsert(updates, { onConflict: "client_id" });
    // "verified, but the save failed" is a state worth naming: the credentials the owner
    // just typed are GOOD, so re-entering them is not the fix and they should not go hunting
    // for a wrong key. dbFail's stock sentence would have lost that, so this one keeps its
    // own wording while still logging through the same path.
    if (upErr) {
      logEdgeError({ fn: "portal-settings", req, clientId, code: upErr.code ?? 500,
        message: `save your CRM connection: ${upErr.message}`, context: { where: "save your CRM connection" } }).catch(() => {});
      return json({ error: 'Your CRM credentials are correct, but saving them failed. Please try again — if it keeps happening, tell CSM Synergy and mention "save your CRM connection".', ref: "save your CRM connection" }, 500);
    }

    // Pricing comes from the per-tenant CSV catalog (building_sizes), not GHL products, so a
    // missing product catalog is no longer worth warning about. A missing USER still blocks
    // estimates (GHL requires a userId on the estimate), so keep that one.
    const warning = !hasUsers
      ? "But this GHL location has no users yet — estimates will be rejected until you assign at least one user to the sub-account."
      : "";
    return json({ ok: true, verified: true, ghlLocationIdMasked: maskId(locationId), hasUsers, hasProducts, warning });
  }

  // List this tenant's GoHighLevel pipelines + their stages, for the portal's
  // pipeline/stage dropdowns. Uses the STORED creds (the browser never holds the
  // API key), so it only works once the connection is saved. Owner/admin only
  // (settings config) — deliberately NOT in READ_ACTIONS. Never returns the key.
  if (action === "list_ghl_pipelines") {
    const { data: cur, error: curErr } = await admin
      .from("client_settings")
      .select("ghl_location_id, ghl_api_key")
      .eq("client_id", clientId)
      .maybeSingle();
    if (curErr) return dbFail(req, clientId, "read your saved CRM credentials", curErr);
    const locationId = cur?.ghl_location_id ?? "";
    const apiKey = cur?.ghl_api_key ?? "";
    if (!locationId || !apiKey) {
      return json({ error: "Connect your CRM first (save a Location ID + API key), then load pipelines." }, 400);
    }
    const ghlHeaders = {
      "Version": "2021-07-28",
      "Authorization": `Bearer ${apiKey}`,
      "Accept": "application/json",
    };
    let r: Response;
    try {
      r = await fetch(`https://services.leadconnectorhq.com/opportunities/pipelines?locationId=${encodeURIComponent(locationId)}`, { headers: ghlHeaders });
    } catch (e) {
      return json({ error: `Couldn't reach GoHighLevel: ${(e as Error).message}` }, 502);
    }
    if (!r.ok) {
      // Authored hint, not GoHighLevel's raw body — same reasoning as verify_save_ghl above.
      const body = (await r.text()).slice(0, 300);
      const hint = (r.status === 401 || r.status === 403)
        ? "The saved API key may be wrong or expired — re-verify the connection above."
        : r.status >= 500
          ? "GoHighLevel is having trouble right now — try Refresh again shortly."
          : "GoHighLevel rejected the request — re-verify the connection above.";
      // Severity: a 401/403 is the SAVED key being refused, which the hint tells the builder to
      // re-verify, and the portal files its own info row for the same 400, so it is info here
      // too. The Settings page loads pipelines on every visit, so an invalid key would otherwise
      // file a fault per visit. Any other status stays an error.
      logEdgeError({
        fn: "portal-settings", req, clientId, code: r.status,
        message: `list_ghl_pipelines: GoHighLevel rejected the pipelines fetch (HTTP ${r.status})`,
        context: { action: "list_ghl_pipelines", body },
        severity: (r.status === 401 || r.status === 403) ? "info" : "error",
      }).catch(() => {});
      return json({ error: `Couldn't load pipelines (HTTP ${r.status}). ${hint}` }, 400);
    }
    const data = await r.json().catch(() => ({}));
    const pipelines = (Array.isArray(data?.pipelines) ? data.pipelines : []).map((p: any) => ({
      id: p.id,
      name: p.name ?? p.id,
      stages: (Array.isArray(p.stages) ? p.stages : []).map((s: any) => ({ id: s.id, name: s.name ?? s.id })),
    }));
    return json({ ok: true, pipelines });
  }

  // Create a building style for THIS tenant (clientId is JWT-resolved, never from the
  // body) so owners can self-serve styles before pricing. An optional base64 image is
  // uploaded to the public 'branding' bucket. Key allocation mirrors admin-catalog's
  // create_style: derive a slug and retry on unique-violation so a concurrent create
  // never silently overwrites a style.
  if (action === "create_style") {
    const label = String(payload.label ?? "").trim();
    if (!label) return json({ error: "Building style name is required." }, 400);
    let imageUrl: string | null = null;
    if (typeof payload.imageBase64 === "string" && payload.imageBase64.trim()) {
      const raw = payload.imageBase64.replace(/^data:[^;]+;base64,/, "");
      const ct = String(payload.imageContentType || "image/jpeg");
      const EXT: Record<string, string> = { "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp", "image/gif": "gif" };
      const ext = EXT[ct];
      if (!ext) return json({ error: "Unsupported image type (use JPG, PNG, WEBP or GIF)." }, 400);
      let bytes: Uint8Array;
      try { bytes = Uint8Array.from(atob(raw), (c) => c.charCodeAt(0)); } catch { return json({ error: "Invalid image data." }, 400); }
      if (bytes.length > 3_000_000) return json({ error: "Image too large (max 3MB)." }, 400);
      // randomUUID, not Date.now() — timestamps are guessable (audit 2026-08-19)
      const path = `${clientId}/style-${crypto.randomUUID()}.${ext}`;
      const up = await admin.storage.from("branding").upload(path, bytes, { contentType: ct, upsert: true });
      if (up.error) return dbFail(req, clientId, "upload that image", up.error);
      const { data: pub } = admin.storage.from("branding").getPublicUrl(path);
      imageUrl = pub.publicUrl;
    }
    const base = (label.toLowerCase().replace(/[^a-z0-9]+/g, "-").slice(0, 40).replace(/^-+|-+$/g, "")) || "style";
    // INSERT then retry on a unique-violation (23505) for a per-client key collision. The
    // global building_style_catalog key-reservation was removed with that table in 030.
    let key = base, n = 1;
    for (let attempt = 0; attempt < 50; attempt++) {
      const ins = await admin.from("building_styles").insert(
        { client_id: clientId, key, label, image_url: imageUrl, sort_order: 0, active: true })
        .select("id, key").maybeSingle();
      if (!ins.error) return json({ ok: true, styleId: ins.data!.id, key: ins.data!.key });
      if (ins.error.code !== "23505") return dbFail(req, clientId, "create that building style", ins.error);
      key = `${base}-${++n}`;
    }
    return json({ error: "Could not allocate a unique style key." }, 500);
  }

  // Show/hide one of this tenant's styles (a hidden style drops out of the designer and
  // the pricing template). Scoped to clientId so an owner can only touch their own styles.
  if (action === "set_style_active") {
    const styleId = String(payload.styleId ?? "").trim();
    if (!styleId) return json({ error: "styleId is required." }, 400);
    const { error } = await admin.from("building_styles")
      .update({ active: payload.active !== false })
      .eq("client_id", clientId).eq("id", styleId);
    if (error) return dbFail(req, clientId, "show or hide that style", error);
    return json({ ok: true });
  }

  // Toggle whether this style's photo is attached to the GHL estimate's building line
  // (default on). Only affects the estimate attachment — the designer still shows the photo.
  if (action === "set_style_estimate_image") {
    const styleId = String(payload.styleId ?? "").trim();
    if (!styleId) return json({ error: "styleId is required." }, 400);
    const { error } = await admin.from("building_styles")
      .update({ show_image_on_estimate: payload.show !== false })
      .eq("client_id", clientId).eq("id", styleId);
    if (error) return dbFail(req, clientId, "update that style's estimate image", error);
    return json({ ok: true });
  }

  // Whether this style's BUILDING line carries sales tax (migration 148). On the style, not
  // the size: taxability is a property of the product, not of how big it is.
  if (action === "set_style_taxable") {
    const styleId = String(payload.styleId ?? "").trim();
    if (!styleId) return json({ error: "styleId is required." }, 400);
    const { error } = await admin.from("building_styles")
      .update({ taxable: payload.taxable !== false })
      .eq("client_id", clientId).eq("id", styleId);
    if (error) return dbFail(req, clientId, "update that style's tax setting", error);
    return json({ ok: true });
  }

  // Upload-only: store a layout-item image in the 'branding' bucket and return its public
  // URL (no DB write). The portal places the URL on the row and persists it via
  // save_layout_pricing → layout_item_pricing.image_url, which submit-estimate then attaches
  // to that item's estimate line. clientId is JWT-resolved (own tenant only).
  if (action === "upload_layout_image") {
    if (typeof payload.imageBase64 !== "string" || !payload.imageBase64.trim()) return json({ error: "No image data." }, 400);
    const raw = payload.imageBase64.replace(/^data:[^;]+;base64,/, "");
    const ct = String(payload.imageContentType || "image/jpeg");
    const EXT: Record<string, string> = { "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp", "image/gif": "gif" };
    const ext = EXT[ct];
    if (!ext) return json({ error: "Unsupported image type (use JPG, PNG, WEBP or GIF)." }, 400);
    let bytes: Uint8Array;
    try { bytes = Uint8Array.from(atob(raw), (c) => c.charCodeAt(0)); } catch { return json({ error: "Invalid image data." }, 400); }
    if (bytes.length > 3_000_000) return json({ error: "Image too large (max 3MB)." }, 400);
    const path = `${clientId}/layout-${crypto.randomUUID()}.${ext}`;
    const up = await admin.storage.from("branding").upload(path, bytes, { contentType: ct, upsert: true });
    if (up.error) return dbFail(req, clientId, "upload that image", up.error);
    const { data: pub } = admin.storage.from("branding").getPublicUrl(path);
    return json({ ok: true, url: pub.publicUrl });
  }

  // Upload-only: store a door photo in the 'fixtures' bucket and return its public URL (no
  // DB write). The portal places the URL on the door row and persists it via save_doors →
  // fixture_items.image_url — the customer-facing photo, and the future 3D source art.
  // clientId is JWT-resolved (own tenant only). Mirrors upload_layout_image.
  if (action === "upload_fixture_image") {
    if (typeof payload.imageBase64 !== "string" || !payload.imageBase64.trim()) return json({ error: "No image data." }, 400);
    const raw = payload.imageBase64.replace(/^data:[^;]+;base64,/, "");
    const ct = String(payload.imageContentType || "image/jpeg");
    const EXT: Record<string, string> = { "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp", "image/gif": "gif" };
    const ext = EXT[ct];
    if (!ext) return json({ error: "Unsupported image type (use JPG, PNG, WEBP or GIF)." }, 400);
    let bytes: Uint8Array;
    try { bytes = Uint8Array.from(atob(raw), (c) => c.charCodeAt(0)); } catch { return json({ error: "Invalid image data." }, 400); }
    if (bytes.length > 3_000_000) return json({ error: "Image too large (max 3MB)." }, 400);
    const path = `${clientId}/door-${crypto.randomUUID()}.${ext}`;
    const up = await admin.storage.from("fixtures").upload(path, bytes, { contentType: ct, upsert: true });
    if (up.error) return dbFail(req, clientId, "upload that image", up.error);
    const { data: pub } = admin.storage.from("fixtures").getPublicUrl(path);
    return json({ ok: true, url: pub.publicUrl });
  }

  // ── Delete one design, its version history, and its PDFs ────────────────────
  // Carolyn, 2026-06-24: deletions had to be done directly in Supabase. This is that control.
  //
  // Guarded by a typed token for anything past Sent, because those are money records: an
  // accepted/invoiced/delivered design has a real estimate (and possibly a real invoice) in
  // the tenant's GHL. Ahsan's call 2026-07-30 was "allow, but make them type it".
  //
  // THREE things have to go, and only the first is obvious:
  //   1. the storage PDFs — the stored image_url columns say WHICH objects, but never get to
  //      say whose: every derived key must match a name this design's own uploads could have
  //      produced (see isOwnFloorPlanKey). The filename cannot simply be rebuilt from the
  //      short_code — three historical shapes exist and the current one carries a Date.now()
  //      suffix — but all three are DERIVABLE from (client_id, short_code), which is what
  //      makes validating them possible where reconstructing them is not.
  //   2. design_versions — there is NO foreign key to designs (verified: zero FKs on either
  //      table), so nothing cascades. Left behind, the rows stay readable by the tenant's own
  //      RLS policy and by list_design_versions/load_design_version, which key on short_code —
  //      i.e. a "deleted" design's full history would remain fetchable.
  //   3. the designs row itself, last, so a failure above never orphans the record that lets
  //      you find the leftovers.
  //
  // …and since 2026-08-01, a FOURTH: the estimate in the tenant's CRM. Carolyn, 2026-07-31 —
  // deleting a design left its estimate behind, so the two systems disagreed about what
  // exists. It is attempted BEFORE the rows go, because `ghl_estimate_id` lives on the row
  // being deleted: run it after and a failure is unretryable, having thrown away the only
  // pointer to the thing left behind. The contact and opportunity are still untouched — they
  // outlive any single design (a repeat customer has several) and are not ours to remove.
  // ── Expected close date, set from the pipeline board card (migration 206) ───────────
  // The board reads `designs` over direct PostgREST, but 154/193's restrictive policies are
  // SELECT-only and there is deliberately no tenant update policy on that table — so this is
  // the write path, with the tenant resolved server-side and never taken from the body.
  if (action === "set_expected_close") {
    const shortCode = String(payload?.shortCode ?? "").trim();
    if (!/^SS-[A-HJ-NP-Z2-9]{6,12}$/.test(shortCode)) return json({ error: "Unknown design." }, 400);

    // null clears the date; anything else must be a real calendar date. The check is not
    // cosmetic: `new Date("2026-02-31")` rolls into March rather than failing, so a typo
    // would be stored as a date nobody chose.
    const raw = payload?.expectedCloseDate;
    let expected: string | null = null;
    if (raw != null && String(raw).trim() !== "") {
      const v = String(raw).trim();
      if (!/^\d{4}-\d{2}-\d{2}$/.test(v)) return json({ error: "That date isn't in a form we recognise." }, 400);
      const d = new Date(v + "T00:00:00Z");
      if (Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== v) {
        return json({ error: "That date doesn't exist — check the day and month." }, 400);
      }
      // A pipeline forecast, not a history field. Bounded so a fat-fingered year cannot park
      // a card in 2226 where no filter or sort will ever surface it again.
      const year = Number(v.slice(0, 4));
      if (year < 2000 || year > 2100) return json({ error: "Pick a close date within the next few years." }, 400);
      expected = v;
    }

    const { error: updErr } = await admin.from("designs")
      .update({ expected_close_date: expected })
      .eq("client_id", clientId).eq("short_code", shortCode);
    if (updErr) return dbFail(req, clientId, "save that close date", updErr);
    return json({ ok: true, expectedCloseDate: expected });
  }

  if (action === "delete_design") {
    // ── OWNER/ADMIN ONLY ──────────────────────────────────────────────────────────────
    // The screen has always said so ("a team member must not be able to destroy a customer
    // record" — portal/02-sales.jsx hides the menu item on isAdmin) and the server used to
    // agree, back when every mutation went through a role gate. Migration 100 replaced that
    // with the area table above, and `designs:edit` is a Sales Rep's preset — so the check
    // the browser was relying on had quietly stopped existing on this one action.
    //
    // Restated here rather than as a second area on the gate: this is a ROLE rule, and the
    // GATES entry says so in its own comment. The area gate above is still the floor — you
    // need designs:edit AND the title — so nothing widens; only the two halves agree again.
    // Operators pass, as they do everywhere in this file: they act as the tenant, and a
    // support operator has already been through checkGate on the owner's map.
    if (!operator && role !== "owner" && role !== "admin") {
      return json({
        error: "Deleting a design is limited to an account owner or admin — ask one of them to remove it.",
      }, 403);
    }
    const shortCode = String(payload.shortCode ?? "").trim();
    if (!shortCode) return json({ error: "shortCode is required." }, 400);

    // Scoped by BOTH client_id and short_code. A code from another tenant matches nothing and
    // returns the same 404 as a code that never existed — no existence oracle.
    const { data: design, error: findErr } = await admin.from("designs")
      .select("id, short_code, status, image_url, ghl_estimate_id, ghl_estimate_number, created_at")
      .eq("client_id", clientId).eq("short_code", shortCode).maybeSingle();
    if (findErr) return dbFail(req, clientId, "find that design", findErr);
    if (!design) return json({ error: "Design not found (or not yours)." }, 404);

    const st = design.status && ["sent", "accepted", "invoiced", "delivered"].includes(design.status)
      ? design.status : "sent";
    // What the operator must retype. The estimate number is the meaningful identifier when
    // one exists; a design can be past Sent without one, so fall back to the short code
    // rather than asking for something that isn't on screen.
    const needsConfirm = st !== "sent";
    const expected = design.ghl_estimate_number ? String(design.ghl_estimate_number) : design.short_code;
    if (needsConfirm) {
      const given = String(payload.confirmToken ?? "").trim();
      if (given !== expected) {
        return json({
          error: `This design is ${st} — a billing record. Type "${expected}" to confirm deletion.`,
          needsConfirm: true, expected, status: st,
        }, 409);
      }
    }

    // 1. Version rows first — we need their image_urls, and they are the invisible leftovers.
    //    A failed read is a 500, not a shrug: carrying on would delete the rows at step 3 with
    //    every version PDF unaccounted for. The action is idempotent, so a retry is free and
    //    strictly better than an orphan nobody can trace.
    const { data: versions, error: verErr } = await admin.from("design_versions")
      .select("id, image_url").eq("client_id", clientId).eq("short_code", shortCode);
    if (verErr) return dbFail(req, clientId, "read that design's version history", verErr);

    // 2. Storage. Every candidate key must be one THIS design could have produced — under
    //    this tenant's prefix and carrying this design's globally-unique short_code. That
    //    reduces image_url from a path to a yes/no, so no value a caller can store selects
    //    another tenant's file, or another design's file within this tenant. Keys that fail
    //    the test are kept and counted, never guessed at.
    const createdAt = Date.parse(String(design.created_at ?? ""));
    const legacyOk = Number.isFinite(createdAt) && createdAt < LEGACY_ROOT_ERA_END;
    const keys = new Set<string>();    // ours — safe to remove
    const kept = new Set<string>();    // distinct stored values we declined to act on
    const foreign = new Set<string>(); // …and the namespaces they named, for triage
    for (const u of [design.image_url, ...(versions ?? []).map((v: any) => v.image_url)]) {
      if (!u) continue; // drafts carry no PDF
      const key = floorPlanKey(u);
      if (key && isOwnFloorPlanKey(key, clientId, design.short_code, legacyOk)) { keys.add(key); continue; }
      kept.add(String(u).slice(0, 300));
      // Only the namespace, and only if it is slug-SHAPED: a real cross-tenant plant names a
      // real slug. Anything else is caller-authored free text, and app_errors is shapes and
      // counts — not a place to let a caller choose what an operator reads.
      const slash = key ? key.indexOf("/") : -1;
      if (key && slash > 0 && !key.startsWith(`${clientId}/`)) {
        const ns = key.slice(0, slash);
        foreign.add(/^[a-z0-9][a-z0-9-]{0,63}$/.test(ns) ? ns : "(non-slug)");
      }
    }
    let filesRemoved = 0;
    if (keys.size) {
      // Best-effort: a storage failure must not block the row delete, or the design becomes
      // undeletable and the tenant is stuck. Orphaned objects are unlisted (migration 042
      // dropped the anon SELECT policy) and cost only space. Refusing a key is best-effort
      // for the same reason — it must never turn into an error the tenant cannot clear.
      const rm = await admin.storage.from(FLOOR_PLANS).remove([...keys]);
      // What storage actually removed. remove() does not error on a key that isn't there, and
      // the old count was the pre-dedupe request length, so it over-reported both ways.
      filesRemoved = rm.error ? 0 : (rm.data?.length ?? 0);
    }

    // 3. The estimate in the tenant's CRM. GHL exposes DELETE /invoices/estimate/:id; altId +
    //    altType scope it to the sub-account. They are NOT sent the way the rest of this file
    //    sends them: for estimate MUTATIONS they are required in the JSON body, and only the
    //    estimate LIST GET takes them on the query string. Assuming "the same pair every other
    //    estimate call already sends" is what shipped a 422 here. Two rules, both deliberate:
    //
    //    (a) NEVER once an invoice exists. Converting an estimate marks it invoiced, and that
    //        invoice is the record behind money that may already have been collected —
    //        deleting its estimate would leave an invoice whose origin no longer exists, which
    //        is a worse inconsistency than the one this closes. Those report `skipped_invoiced`
    //        and the dialog tells the operator to void the invoice in the CRM first. The check
    //        reads invoice_sends rather than trusting `status` alone, because status is a
    //        cached projection that sync-design-status can downgrade on a GHL blip — the
    //        claim ledger is the durable fact that an invoice was created.
    //    (b) BEST-EFFORT, exactly like storage. A tenant's key may predate this feature and
    //        lack the estimates scope; a 401/403/5xx must never make the design undeletable
    //        and strand the local rows. The outcome is returned, audited, and (on failure)
    //        logged — never thrown.
    //    (c) OPT-IN PER REQUEST. The caller must send `deleteEstimate: true`. This is a
    //        compatibility gate, not a preference: this function serves beta AND production
    //        portal.html at the same time, and production keeps serving the previous build
    //        until the Monday promotion. That older dialog tells the operator in as many
    //        words that the estimate is NOT affected — so changing the behaviour underneath
    //        it would delete records in a client's CRM that they were just promised would
    //        survive. Old page ⇒ no flag ⇒ old behaviour, exactly.
    let estimate: "none" | "deleted" | "skipped_invoiced" | "not_connected" | "failed" = "none";
    let estimateError: string | null = null;
    if (design.ghl_estimate_id && payload.deleteEstimate === true) {
      const { data: inv } = await admin.from("invoice_sends")
        .select("invoice_id").eq("client_id", clientId).eq("short_code", shortCode).maybeSingle();
      if (inv?.invoice_id || st === "invoiced" || st === "delivered") {
        estimate = "skipped_invoiced";
      } else {
        const { data: creds } = await admin.from("client_settings")
          .select("ghl_location_id, ghl_api_key").eq("client_id", clientId).maybeSingle();
        if (!creds?.ghl_location_id || !creds?.ghl_api_key) {
          estimate = "not_connected";
        } else {
          try {
            const r = await fetch(
              `https://services.leadconnectorhq.com/invoices/estimate/${encodeURIComponent(String(design.ghl_estimate_id))}` +
                `?altId=${encodeURIComponent(creds.ghl_location_id)}&altType=location`,
              {
                method: "DELETE",
                headers: {
                  Authorization: `Bearer ${creds.ghl_api_key}`,
                  Version: "2021-07-28",
                  Accept: "application/json",
                  "Content-Type": "application/json",
                },
                // altId/altType go in the BODY for this endpoint. They are REQUIRED there, and
                // sending them only on the query string is a missing-required-field DTO failure
                // -> 422, which reads exactly like a state refusal and is why this looked like
                // "GHL will not let us delete it" for a month. The query string is kept as well:
                // it is harmless, and it covers the alternate reading of their docs.
                body: JSON.stringify({ altId: creds.ghl_location_id, altType: "location" }),
              },
            );
            // 404 is the desired end state reached by another route (already deleted in the
            // CRM, or a half-finished earlier attempt), so it counts as done rather than as an
            // error the operator has to interpret. That is also what makes a retry safe.
            estimate = (r.ok || r.status === 404) ? "deleted" : "failed";
            // Keep GHL's own words. A bare status turned a one-line DTO complaint into a
            // month of guessing; the body is their validation output, so it carries no
            // customer data. Capped because it lands in an error row, not a log stream.
            if (estimate === "failed") {
              const detail = (await r.text().catch(() => "")).slice(0, 300);
              estimateError = `CRM returned ${r.status}${detail ? `: ${detail}` : ""}`;
            }
          } catch (e) {
            estimate = "failed";
            estimateError = (e as Error)?.message || "network error";
          }
        }
      }
    }

    // 4. Versions, then the design. The version delete failing is NOT ignorable: deleting the
    //    designs row anyway would strand those version rows, and list_design_versions is
    //    SECURITY DEFINER, granted to anon, and keyed on short_code ALONE — so a stranded row's
    //    contact jsonb stays fetchable by a code that is already sitting in sent customer email,
    //    with no designs row left to show anyone it happened. Stop before that becomes true; the
    //    action is idempotent, so a retry finishes the job.
    const { error: verDelErr, count: versionsDeleted } = await admin.from("design_versions")
      .delete({ count: "exact" }).eq("client_id", clientId).eq("short_code", shortCode);
    if (verDelErr) return dbFail(req, clientId, "delete that design's version history", verDelErr);
    const { error: delErr, count } = await admin.from("designs")
      .delete({ count: "exact" }).eq("client_id", clientId).eq("short_code", shortCode);
    if (delErr) return dbFail(req, clientId, "delete that design", delErr);
    if (!count) return json({ error: "Design not found (or not yours)." }, 404);

    // Durable: deleting a customer's design is not something we accept losing the record of.
    // Signature is (action, rowCount, note) — the tenant is already implicit in the resolved
    // context, so passing clientId here would silently land in rowCount.
    await auditStrict("portal_delete_design", 1 + (versionsDeleted ?? 0),
      `code=${shortCode} status=${st} versions=${versionsDeleted ?? 0} files=${filesRemoved} kept=${kept.size} estimate=${estimate}`);
    // A CRM estimate we could not remove is a real leftover in someone else's system, and the
    // row that pointed at it is now gone — so it goes in error_events, where support can find
    // it, rather than living only in a banner the operator dismisses. The estimate id is the
    // whole point of the record: without it nobody can finish the job by hand.
    if (estimate === "failed") {
      await logEdgeError({
        fn: "portal-settings", req, clientId, code: "delete_design_estimate_failed",
        message: `CRM estimate delete failed: ${estimateError ?? "unknown"}`,
        context: { shortCode, estimateId: String(design.ghl_estimate_id ?? ""), status: st },
      });
    }
    // A stored URL naming something this design could not have produced is not something a
    // tenant does by accident, so it gets a durable row rather than a substring in a note
    // nobody greps. Counts and namespace slugs only — never the URL itself, and never any
    // customer data (the app_errors doctrine).
    if (kept.size) {
      await logEdgeError({
        fn: "portal-settings", req, clientId, code: "delete_design_key_refused",
        message: `delete_design kept ${kept.size} unrecognised object key(s)`,
        context: { shortCode, refused: kept.size, namespaces: [...foreign].slice(0, 5) },
      });
    }
    return json({
      ok: true, shortCode, versionsDeleted: versionsDeleted ?? 0, filesRemoved, filesKept: kept.size,
      estimate, estimateNumber: design.ghl_estimate_number ?? null, estimateError,
    });
  }

  // Permanently delete one of this tenant's styles. The FK cascade removes the style's
  // building_sizes (and their size-inclusions) and its style-specific layout_item_pricing
  // overrides; default (style_id IS NULL) pricing, colors, and options are untouched.
  // Irreversible — prefer set_style_active(false) to merely hide a style. Scoped to clientId
  // so an owner can only delete their own styles. Past designs that used this style keep their
  // saved geometry/PDF/estimate, but can no longer be re-priced (submit-estimate will report
  // "No price is set" on resubmit), since the style/sizes are gone from the catalog.
  // (This comment sat above delete_design until 2026-08-07 — a truncated edit had stranded
  // it ~200 lines from the action it describes, which had none of its own.)
  if (action === "delete_style") {
    const styleId = String(payload.styleId ?? "").trim();
    if (!styleId) return json({ error: "styleId is required." }, 400);
    const { error, count } = await admin.from("building_styles")
      .delete({ count: "exact" })
      .eq("client_id", clientId).eq("id", styleId);
    if (error) return dbFail(req, clientId, "delete that style", error);
    if (!count) return json({ error: "Style not found (or not yours)." }, 404);
    return json({ ok: true });
  }

  // Update one of this tenant's styles: rename and/or replace its image. Scoped to clientId.
  // Only fields present in the body are written; an absent image leaves the current one intact.
  // Does not touch sizes/prices (CSV) or active state (set_style_active).
  if (action === "update_style") {
    const styleId = String(payload.styleId ?? "").trim();
    if (!styleId) return json({ error: "styleId is required." }, 400);
    const updates: Record<string, unknown> = {};
    if ("label" in payload) {
      const label = String(payload.label ?? "").trim();
      if (!label) return json({ error: "Building style name can't be empty." }, 400);
      updates.label = label;
    }
    // Serial-number code (163). Carolyn, 2026-08-28 @57:20: "all of their buildings have
    // codes. They come up with them. LBA. Okay. Stands for Lofted Barn." It is the second
    // segment of every serial this style produces, so it is upper-cased and capped at 4 --
    // 0826LBA1016REBLDWS5000. Presence-guarded like `label`, so a caller sending only an
    // image cannot blank it. An empty string stores NULL rather than '', which is what makes
    // the partial unique index treat un-coded styles as un-set instead of as duplicates.
    if ("code" in payload) {
      updates.code = String(payload.code ?? "").trim().toUpperCase().slice(0, 4) || null;
    }
    if (typeof payload.imageBase64 === "string" && payload.imageBase64.trim()) {
      const raw = payload.imageBase64.replace(/^data:[^;]+;base64,/, "");
      const ct = String(payload.imageContentType || "image/jpeg");
      const EXT: Record<string, string> = { "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp", "image/gif": "gif" };
      const ext = EXT[ct];
      if (!ext) return json({ error: "Unsupported image type (use JPG, PNG, WEBP or GIF)." }, 400);
      let bytes: Uint8Array;
      try { bytes = Uint8Array.from(atob(raw), (c) => c.charCodeAt(0)); } catch { return json({ error: "Invalid image data." }, 400); }
      if (bytes.length > 3_000_000) return json({ error: "Image too large (max 3MB)." }, 400);
      const path = `${clientId}/style-${crypto.randomUUID()}.${ext}`;
      const up = await admin.storage.from("branding").upload(path, bytes, { contentType: ct, upsert: true });
      if (up.error) return dbFail(req, clientId, "upload that image", up.error);
      const { data: pub } = admin.storage.from("branding").getPublicUrl(path);
      updates.image_url = pub.publicUrl;
    }
    if (Object.keys(updates).length === 0) return json({ error: "Nothing to update." }, 400);
    updates.updated_at = new Date().toISOString();
    const { error, count } = await admin.from("building_styles")
      .update(updates, { count: "exact" })
      .eq("client_id", clientId).eq("id", styleId);
    if (error) return dbFail(req, clientId, "save that style", error);
    if (!count) return json({ error: "Style not found (or not yours)." }, 404);
    return json({ ok: true, imageUrl: updates.image_url ?? null });
  }

  // ─── 3D setup (086): the builder calibrates how their buildings look in 3D ───
  // These three replace an operator-only path that could not work: admin-save-settings'
  // save_style_d3 wrote client_configs.config, a column dropped in 020, so every save
  // 404'd. Doing it here instead means the BUILDER can do it themselves against their own
  // JWT — which is the whole product bet (no setup fees, no work queued on us).

  // Save one style's 3D appearance spec. Keyed on styleValue (the style `key`) because
  // that is all the embedded designer knows — get_config emits `value`, never the row id —
  // and (client_id, key) is unique. styleId is accepted too for callers that have it.
  // Resolve one of this tenant's styles by key-or-id, and report whether its 3D setup is
  // LOCKED. Shared by every write below so the lock cannot be enforced in one place and
  // forgotten in another.
  // One style row as the 3D actions read it. The d3/media/updated_at members exist for the
  // late-save guard; the lock and scan actions only ever touch id, key and the model fields.
  type Style3D = {
    id: string; key: string; model_status: string; model_url: string | null;
    d3: unknown; d3_photos: unknown; d3_video_frames: unknown; updated_at: string | null;
  };
  const findStyleFor3D = async (styleValue: string, styleId: string) => {
    // d3, the two media columns and updated_at ride along for the late-save guard in
    // save_style_d3 / save_style_media (styleSaveGuard.ts); every other caller ignores them.
    let q = admin.from("building_styles").select("id, key, model_status, model_url, d3, d3_photos, d3_video_frames, updated_at").eq("client_id", clientId);
    q = styleId ? q.eq("id", styleId) : q.eq("key", styleValue);
    const { data, error } = await q.maybeSingle();
    if (error) return { err: json({ error: error.message }, 500) };
    if (!data) return { err: json({ error: "Style not found (or not yours)." }, 404) };
    return { style: data as Style3D };
  };
  // The lock freezes SETUP only. Prices, sizes, active/hidden and the estimate-image flag stay
  // editable on a locked style on purpose: those are commercial decisions a builder makes every
  // week, while the geometry is the thing that must stop moving once it matches a real building
  // customers are being quoted against.
  const LOCKED_MSG = "This style's 3D setup is locked. Unlock it first if you really need to change the shape.";
  // THE LATE-SAVE GUARD'S REFUSAL (2026-09-14) — see _shared/styleSaveGuard.ts for why a save
  // can arrive after a newer one. `conflict: true` is what tells the portal this 409 is not the
  // lock above: it takes `current.updatedAt` as its new base and resends once, because the save
  // the builder is waiting on IS the latest intent. A late copy of an older save gets the same
  // answer, but nobody is waiting for it any more, so it simply never lands.
  const styleConflict = (style: Style3D) => json({
    error: "This style was changed after you opened it. Reopen it to see the latest, then save again.",
    conflict: true,
    current: { updatedAt: style.updated_at ?? null, d3: style.d3 ?? null, d3Photos: mediaList(style.d3_photos), d3VideoFrames: mediaList(style.d3_video_frames) },
  }, 409);

  if (action === "save_style_d3") {
    const styleValue = String(payload.styleValue ?? "").trim();
    const styleId = String(payload.styleId ?? "").trim();
    if (!styleValue && !styleId) return json({ error: "styleValue (or styleId) is required." }, 400);
    const clean = sanitizeD3Spec(payload.d3);
    if (!clean.ok) return json({ error: clean.error }, 400);
    // ⚠️ THE `max` ARGUMENT IS THE WHOLE FIX HERE. This call used the DEFAULT of 4, so the
    // extra angles Carolyn asked for on 2026-09-04 ("they may just add more") were accepted by
    // the editor, read by the generator, and then silently dropped by the save - HTTP 200, no
    // warning, and gone on the next open. The editor's own ceiling is CAL_PHOTO_MAX (12) and
    // sanitizePhotoUrls' hard ceiling is 12, so 12 is the honest number for the column too.
    const photos = sanitizePhotoUrls(payload.d3Photos, 12);
    // The walk-around's frames, kept beside the photos rather than mixed into them (2026-09-10).
    // They are a SEPARATE column because the two are answers to different questions: "what has
    // this builder photographed" and "has this style got a walk-around at all". Mixed into one
    // array, as they were until today, the second question has no answer after a reload - so the
    // Generate gate would demand a video the builder had already filmed. Cap: WALK_FRAME_MAX (12
    // since 2026-09-24, was 8) — SS_VID_FRAMES, and the self-check only pairs frames stored here.
    //
    // ⚠️ ABSENCE IS NOT EMPTINESS, and this column is the first one here where the difference
    // bites. sanitizePhotoUrls answers [] for undefined exactly as it does for [], so writing it
    // unconditionally meant every caller that does not KNOW the frames - the operator ?admin=1
    // page, which has no Step 1 card at all, and the portal in the window before its
    // authenticated refetch lands - silently wiped a walk-around already on file. Only a caller
    // that actually sent an array gets to touch it; everyone else leaves it as they found it.
    const hasVideoFrames = Array.isArray(payload.d3VideoFrames);
    // WALK_FRAME_MAX (12 since 2026-09-24), in step with the designer's SS_VID_FRAMES. The STORED lap has to hold
    // every frame a generation can be sent: the self-check pairs only frames found in the
    // style's own stored media (selfCheckPairs), so a lap cut to 8 here drops frames 9-12 from
    // every check -- and a reload would hand Generate eight views of a twelve-view lap.
    const videoFrames = sanitizePhotoUrls(payload.d3VideoFrames, WALK_FRAME_MAX);
    const found = await findStyleFor3D(styleValue, styleId);
    if (found.err) return found.err;
    if (found.style!.model_status === "locked") return json({ error: LOCKED_MSG }, 409);
    // roofProfile (2026-09-15): ABSENCE IS NOT A CLEAR, the d3VideoFrames rule above. A bundle
    // that predates the key (production until the Monday promotion) sends a d3 without it, so
    // sanitizeD3Spec leaves it out and this write would silently put a post-frame style back to
    // AG Panel. Carry the stored value forward. The current editor always sends the key (null
    // for AG Panel), which is how a real clear still lands. Done BEFORE the guard, so a save that
    // only omits the key compares as the duplicate it is.
    {
      const sentD3 = payload.d3 as Record<string, unknown> | null | undefined;
      const stored = (found.style!.d3 as Record<string, unknown> | null)?.roofProfile;
      if (sentD3 && typeof sentD3 === "object" && !("roofProfile" in sentD3) && (stored === "agpanel" || stored === "standingseam")) {
        clean.d3.roofProfile = stored;
      }
    }
    // A RAISED FOUNDATION (blocks / piers and floorHeightFt, 2026-09-25): an older panel sends
    // foundation null (or a draft's "slab") and never floorHeightFt, so a save without frame
    // "front" keeps the stored pair (carryForwardFoundation). The current panel sends frame "front"
    // and gets what it sent. Before the guard too, so an old panel's re-save of a raised style
    // compares as the duplicate it is.
    carryForwardFoundation(clean.d3, payload.d3, found.style!.d3, payload.frame);
    // THE LATE-SAVE GUARD, BY VERSION (see _shared/styleSaveGuard.ts, and why content alone was
    // not enough). A caller that sent no baseVersion — an older bundle, the operator ?admin=1
    // page — writes unconditionally, exactly as before. A DUPLICATE (this exact save already
    // landed) answers ok and writes nothing, so it cannot bump the version under a save that is
    // still on its way. Only the columns this save writes are compared.
    const decision = guardDecision({
      baseVersion: "baseVersion" in payload ? (payload.baseVersion ?? null) : undefined,
      currentVersion: found.style!.updated_at,
      columns: [
        { current: found.style!.d3 ?? null, next: clean.d3 },
        { current: mediaList(found.style!.d3_photos), next: photos },
        ...(hasVideoFrames ? [{ current: mediaList(found.style!.d3_video_frames), next: videoFrames }] : []),
      ],
    });
    if (decision === "conflict") return styleConflict(found.style!);
    if (decision === "duplicate") {
      return json(hasVideoFrames
        ? { ok: true, duplicate: true, updatedAt: found.style!.updated_at, d3: clean.d3, d3Photos: photos, d3VideoFrames: videoFrames }
        : { ok: true, duplicate: true, updatedAt: found.style!.updated_at, d3: clean.d3, d3Photos: photos });
    }
    let write = admin.from("building_styles")
      .update(
        hasVideoFrames
          ? { d3: clean.d3, d3_photos: photos, d3_video_frames: videoFrames, updated_at: new Date().toISOString() }
          : { d3: clean.d3, d3_photos: photos, updated_at: new Date().toISOString() },
        { count: "exact" },
      )
      .eq("client_id", clientId).eq("id", found.style!.id);
    // AND ATOMIC. The decision above read the row a moment ago; the write only lands if nobody
    // has written it since, which closes the gap between that read and this update.
    if (decision === "write") write = found.style!.updated_at ? write.eq("updated_at", found.style!.updated_at) : write.is("updated_at", null);
    const { data: wrote, error, count } = await write.select("updated_at");
    if (error) return json({ error: error.message }, 500);
    if (!count) {
      if (decision === "write") {
        const again = await findStyleFor3D(styleValue, styleId);
        if (again.err) return again.err;
        return styleConflict(again.style!);
      }
      return json({ error: "Style not found (or not yours)." }, 404);
    }
    // The version this save just stamped, as the database prints it: the portal's next base.
    const updatedAt = (Array.isArray(wrote) && wrote[0] && (wrote[0] as { updated_at?: string | null }).updated_at) || null;
    // Only reports what it wrote. Echoing `videoFrames` on a save that deliberately left the
    // column alone would tell the caller their frames are now [] and invite them to believe it.
    return json(hasVideoFrames
      ? { ok: true, updatedAt, d3: clean.d3, d3Photos: photos, d3VideoFrames: videoFrames }
      : { ok: true, updatedAt, d3: clean.d3, d3Photos: photos });
  }

  // Persist ONLY the reference media — the photos and the walk-around frames — leaving the d3
  // spec exactly as it is (2026-09-11).
  //
  // WHY A SEPARATE ACTION rather than reusing save_style_d3: that one writes `d3` too, and the
  // spec in the editor at upload time is a DRAFT nobody has approved. Uploading a photo must not
  // commit a half-tuned roof pitch to every customer's 3D. These are two different decisions and
  // they deserve two different endpoints.
  //
  // WHY AT ALL: switching style tabs re-seeds the editor from the SAVED row, so until now
  // everything uploaded before pressing Save was lost by clicking another style. Save is
  // deliberately the last act of tuning, which left the entire upload phase unprotected. The
  // images are already in the bucket by this point — this only records which ones belong to the
  // style, so it is cheap and idempotent.
  //
  // Honours the lock for the same reason save_style_d3 does: a locked style's 3D setup is frozen,
  // and its reference set is part of that setup.
  if (action === "save_style_media") {
    const styleValue = String(payload.styleValue ?? "").trim();
    const styleId = String(payload.styleId ?? "").trim();
    if (!styleValue && !styleId) return json({ error: "styleValue (or styleId) is required." }, 400);
    const found = await findStyleFor3D(styleValue, styleId);
    if (found.err) return found.err;
    if (found.style!.model_status === "locked") return json({ error: LOCKED_MSG }, 409);
    // Absence still means "leave that column alone", exactly as in save_style_d3 — a caller that
    // only knows about photos must not blank the frames.
    const patch: Record<string, unknown> = { updated_at: new Date().toISOString() };
    if (Array.isArray(payload.d3Photos)) patch.d3_photos = sanitizePhotoUrls(payload.d3Photos, 12);
    if (Array.isArray(payload.d3VideoFrames)) patch.d3_video_frames = sanitizePhotoUrls(payload.d3VideoFrames, WALK_FRAME_MAX);
    if (Object.keys(patch).length === 1) return json({ ok: true, skipped: true });
    // The same version guard as save_style_d3, over only the columns this call writes.
    const decision = guardDecision({
      baseVersion: "baseVersion" in payload ? (payload.baseVersion ?? null) : undefined,
      currentVersion: found.style!.updated_at,
      columns: [
        ...("d3_photos" in patch ? [{ current: mediaList(found.style!.d3_photos), next: patch.d3_photos }] : []),
        ...("d3_video_frames" in patch ? [{ current: mediaList(found.style!.d3_video_frames), next: patch.d3_video_frames }] : []),
      ],
    });
    if (decision === "conflict") return styleConflict(found.style!);
    // What this call writes, after sanitising — echoed so the portal sees the stored lists.
    const echo = {
      ...("d3_photos" in patch ? { d3Photos: patch.d3_photos } : {}),
      ...("d3_video_frames" in patch ? { d3VideoFrames: patch.d3_video_frames } : {}),
    };
    if (decision === "duplicate") return json({ ok: true, duplicate: true, updatedAt: found.style!.updated_at, ...echo });
    let write = admin.from("building_styles")
      .update(patch, { count: "exact" })
      .eq("client_id", clientId).eq("id", found.style!.id);
    if (decision === "write") write = found.style!.updated_at ? write.eq("updated_at", found.style!.updated_at) : write.is("updated_at", null);
    const { data: wrote, error, count } = await write.select("updated_at");
    if (error) return dbFail(req, clientId, "save those photos", error);
    if (!count) {
      if (decision === "write") {
        const again = await findStyleFor3D(styleValue, styleId);
        if (again.err) return again.err;
        return styleConflict(again.style!);
      }
      return json({ error: "Style not found (or not yours)." }, 404);
    }
    // The version this call just stamped: the portal's next base.
    const updatedAt = (Array.isArray(wrote) && wrote[0] && (wrote[0] as { updated_at?: string | null }).updated_at) || null;
    return json({ ok: true, updatedAt, ...echo });
  }

  // ─── Building scan (094) ───────────────────────────────────────────────────────────────
  // The browser uploads the .glb straight into the PRIVATE `models` bucket with its own
  // session (the same route portal.html already uses for feedback attachments) — a 10-40 MB
  // mesh cannot go through an edge function, which would have to buffer it as base64 inside a
  // 256 MB / 2 s worker. These actions therefore handle the metadata and the lifecycle, and
  // one of them hands back a short-lived signed URL so the editor can load a mesh that is
  // deliberately not public.

  // Record an uploaded scan against a style. `modelPath` is an object path, never a URL, and
  // it is re-derived from the tenant here so a caller cannot point a style at another
  // tenant's object by sending a crafted path.
  if (action === "save_style_model") {
    const styleValue = String(payload.styleValue ?? "").trim();
    const styleId = String(payload.styleId ?? "").trim();
    const rawPath = String(payload.modelPath ?? "").trim();
    if (!styleValue && !styleId) return json({ error: "styleValue (or styleId) is required." }, 400);
    if (!rawPath) return json({ error: "modelPath is required." }, 400);
    if (!rawPath.startsWith(`${clientId}/`) || rawPath.includes("..") || !/\.glb$/i.test(rawPath)) {
      return json({ error: "That scan path does not belong to this builder." }, 400);
    }
    const found = await findStyleFor3D(styleValue, styleId);
    if (found.err) return found.err;
    if (found.style!.model_status === "locked") return json({ error: LOCKED_MSG }, 409);
    // Confirm the object really is there and really is a GLB before pointing a style at it:
    // catches a failed upload, a renamed file, or anything that is not glTF, instead of
    // storing a reference that breaks later. Deliberately a RANGE request rather than
    // storage.download(): the client SDK has no range option, so downloading would pull the
    // whole 10-40 MB mesh into a 256 MB worker to read twelve bytes.
    const sbUrl = Deno.env.get("SUPABASE_URL");
    const svcKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
    if (!sbUrl || !svcKey) return json({ error: "Storage is not configured on the server." }, 500);
    let magic: Uint8Array;
    try {
      const headRes = await fetch(`${sbUrl}/storage/v1/object/models/${rawPath.split("/").map(encodeURIComponent).join("/")}`, {
        headers: { Authorization: `Bearer ${svcKey}`, apikey: svcKey, Range: "bytes=0-11" },
      });
      if (!headRes.ok && headRes.status !== 206) {
        return json({ error: "That scan is not in storage — the upload did not finish. Try uploading it again." }, 400);
      }
      magic = new Uint8Array(await headRes.arrayBuffer());
    } catch (e) {
      return json({ error: `Could not read that scan: ${e instanceof Error ? e.message : String(e)}` }, 502);
    }
    // "glTF" — the GLB container magic. Anything else is a renamed .obj/.usdz/.zip.
    const isGlb = magic.length >= 4 && magic[0] === 0x67 && magic[1] === 0x6C && magic[2] === 0x54 && magic[3] === 0x46;
    if (!isGlb) return json({ error: "That file is not a .glb scan — its header does not say glTF. Re-export it as GLB." }, 400);
    const meta = (payload.modelMeta && typeof payload.modelMeta === "object" && !Array.isArray(payload.modelMeta))
      ? payload.modelMeta : null;
    if (meta && JSON.stringify(meta).length > 4096) return json({ error: "Those scan measurements are implausibly large." }, 400);
    const { error, count } = await admin.from("building_styles").update({
      model_url: rawPath, model_status: "uploaded", model_uploaded_at: new Date().toISOString(),
      model_meta: meta, model_locked_at: null, updated_at: new Date().toISOString(),
    }, { count: "exact" }).eq("client_id", clientId).eq("id", found.style!.id);
    if (error) return json({ error: error.message }, 500);
    if (!count) return json({ error: "Style not found (or not yours)." }, 404);
    return json({ ok: true, modelPath: rawPath });
  }

  // Move a style through the scan lifecycle. `locked` is what Carolyn asked for: once the 3D
  // matches the real building, stop the shape moving. Unlocking is allowed — a builder who
  // rebuilds a model or re-scans must not need us — but it is an explicit act, which is the
  // whole point of the state.
  if (action === "set_style_model_status") {
    const styleValue = String(payload.styleValue ?? "").trim();
    const styleId = String(payload.styleId ?? "").trim();
    const status = String(payload.status ?? "").trim();
    if (!["none", "uploaded", "calibrated", "locked"].includes(status)) {
      return json({ error: `Unknown 3D status "${status}".` }, 400);
    }
    const found = await findStyleFor3D(styleValue, styleId);
    if (found.err) return found.err;
    if (status !== "none" && !found.style!.model_url && status !== "calibrated") {
      return json({ error: "There is no scan on this style yet." }, 400);
    }
    const patch: Record<string, unknown> = { model_status: status, updated_at: new Date().toISOString() };
    patch.model_locked_at = status === "locked" ? new Date().toISOString() : null;
    if (status === "none") { patch.model_url = null; patch.model_meta = null; patch.model_uploaded_at = null; }
    const { error, count } = await admin.from("building_styles")
      .update(patch, { count: "exact" }).eq("client_id", clientId).eq("id", found.style!.id);
    if (error) return json({ error: error.message }, 500);
    if (!count) return json({ error: "Style not found (or not yours)." }, 404);
    return json({ ok: true, status });
  }

  // Short-lived signed URL so the editor can load a scan out of the private bucket. Ten
  // minutes is long enough to download and parse a 40 MB mesh and short enough that a URL
  // pasted somewhere by accident stops working.
  if (action === "style_model_url") {
    const styleValue = String(payload.styleValue ?? "").trim();
    const styleId = String(payload.styleId ?? "").trim();
    const found = await findStyleFor3D(styleValue, styleId);
    if (found.err) return found.err;
    const path = found.style!.model_url;
    if (!path) return json({ ok: true, url: null, status: found.style!.model_status });
    const signed = await admin.storage.from("models").createSignedUrl(path, 600);
    if (signed.error || !signed.data) return json({ error: `Could not open that scan: ${signed.error?.message ?? "unknown"}` }, 500);
    return json({ ok: true, url: signed.data.signedUrl, status: found.style!.model_status });
  }

  // Upload-only: a reference photo of a real building, stored beside the style images in
  // `branding` and handed back as a URL for a d3Photos slot. Mirrors upload_fixture_image.
  // (Repo migration 041 proposed putting these in floor-plans; that bucket has been
  // PDF-only since 071, so 041 is dead and must not be applied.)
  if (action === "upload_style_photo") {
    if (typeof payload.imageBase64 !== "string" || !payload.imageBase64.trim()) return json({ error: "No image data." }, 400);
    const raw = payload.imageBase64.replace(/^data:[^;]+;base64,/, "");
    const ct = String(payload.imageContentType || "image/jpeg");
    const EXT: Record<string, string> = { "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp", "image/gif": "gif" };
    const ext = EXT[ct];
    if (!ext) return json({ error: "Unsupported image type (use JPG, PNG, WEBP or GIF)." }, 400);
    let bytes: Uint8Array;
    try { bytes = Uint8Array.from(atob(raw), (c) => c.charCodeAt(0)); } catch { return json({ error: "Invalid image data." }, 400); }
    if (bytes.length > 3_000_000) return json({ error: "Image too large (max 3MB)." }, 400);
    // The REFERENCE-photo class the enumerability audit was about: photos of a builder's
    // real buildings in a public bucket. randomUUID makes the URL an unguessable
    // capability; the payload side was already handled (093 keeps d3_photos out of the
    // anon get_config).
    const path = `${clientId}/style-photo-${crypto.randomUUID()}.${ext}`;
    const up = await admin.storage.from("branding").upload(path, bytes, { contentType: ct, upsert: true });
    if (up.error) return json({ error: `Image upload failed: ${up.error.message}` }, 500);
    const { data: pub } = admin.storage.from("branding").getPublicUrl(path);
    return json({ ok: true, url: pub.publicUrl });
  }

  // Mint a signed URL so the BROWSER writes the image straight into the bucket (2026-09-11).
  //
  // `upload_style_photo` above still works and is still the fallback, but it is the slow path:
  // it takes the image as base64 in a JSON body, which inflates every byte by 4/3, spends the
  // function's own memory decoding it, and gives the caller one all-or-nothing POST with no
  // resume. On a slow or lossy uplink that is the difference between an upload that lands and
  // one that does not — a builder on ~42KB/s had six of nine photos fail.
  //
  // A SIGNED URL RATHER THAN A DIRECT BUCKET WRITE, and the distinction is load-bearing. Storage
  // RLS confines a browser write to the folder named by the CALLER's own client_users row, which
  // is right up until an operator uses view-as: their row names their own tenant, so the path
  // built from the viewed tenant can never match and every upload is refused with a raw "new row
  // violates row-level security policy". 094 and onUploadModel both document that trap. Here
  // `resolveTenant` decides the prefix, so view-as works and the browser needs no bucket grant
  // at all.
  //
  // The URL is single-use and short-lived, and it names a path this function chose — a caller
  // cannot aim it at another tenant's folder.
  if (action === "style_photo_upload_url") {
    const ct = String(payload.contentType || "image/jpeg");
    const EXT: Record<string, string> = { "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp", "image/gif": "gif" };
    const ext = EXT[ct];
    if (!ext) return json({ error: "Unsupported image type (use JPG, PNG, WEBP or GIF)." }, 400);
    // BULK SINCE 2026-09-12. Minting one URL per image meant every image cost TWO round trips —
    // mint, then PUT — and on a high-latency uplink the round trips ARE the cost, not the bytes.
    // Eight images went from sixteen trips to nine. The cap matches CAL_PHOTO_MAX plus the eight
    // walk-around frames a single video produces, because both paths mint through here.
    //
    // Absent `count` still returns the single-object shape, so an older bundle mid-deploy keeps
    // working against a newer function. That is not hypothetical: the compiled portal and this
    // function ship separately and a builder can be holding either for minutes.
    const want = Math.max(1, Math.min(20, Math.floor(Number(payload.count) || 1)));
    const uploads: { path: string; token: string | undefined; url: string }[] = [];
    for (let i = 0; i < want; i++) {
      // randomUUID per object, exactly as before: the public URL is an unguessable capability,
      // which is what 093 leans on now that d3_photos is out of the anonymous get_config payload.
      const path = `${clientId}/style-photo-${crypto.randomUUID()}.${ext}`;
      const { data: signed, error } = await admin.storage.from("branding").createSignedUploadUrl(path);
      if (error) {
        // Partial success is the honest answer: the caller uploads what it was given URLs for
        // and reports the rest as failures, rather than losing a whole batch to one bad mint.
        if (!uploads.length) return dbFail(req, clientId, "start that upload", error);
        break;
      }
      const { data: pub } = admin.storage.from("branding").getPublicUrl(path);
      uploads.push({ path, token: signed?.token, url: pub.publicUrl });
    }
    const first = uploads[0];
    return json({ ok: true, uploads, path: first?.path, token: first?.token, url: first?.url });
  }

  // ── PICK UP A STREAMED DRAFT WHOSE ANSWER NEVER ARRIVED (2026-09-25, BY KEY SINCE 253) ─────────
  // A streamed draft (calibrate_style_ai below, answered by draftAnswer) takes three to five
  // minutes behind its heartbeat, and a phone that backgrounds the tab or a network that blinks
  // drops that answer while the server works on, or after it has finished and charged. The same
  // key asked again either runs the model a second time or meets hold_in_flight / already_charged.
  // But the server writes what it drafted onto the generation's ledger row, so the new shell,
  // instead of telling the builder to try again, asks HERE: at once when the answer drops, then
  // every ten seconds until the draft is there, the server says it never will be, or the press's
  // own seven minutes run out.
  //
  // ⚠️ THE PRESS IS FOUND BY ITS OWN KEY (253), and nothing here reads a clock the browser sent.
  // The body names the style and the idempotency key the press went out with; the ledger insert
  // below writes that key onto the press's row and wallet_hold files the hold under it, so the rows
  // read here are that press's and nobody else's -- never a later press on another tab or device,
  // which mints its own key -- and the sentence about money comes from that press's wallet rows,
  // never from how long ago anything happened (styleD3.ts's recoverDraftAnswer has the table).
  //
  // ⛔ ONLY THE CALLER'S OWN ROWS. The gate is calibrate_style_ai's (GATES), and both reads are
  // filtered on the RESOLVED tenant and the RESOLVED user -- never on anything in the body -- plus
  // the key, the style and the shape-first sources. So an operator in view-as reads only the rows
  // they generated there, and a key from another tenant or user finds nothing.
  //
  // No model call and no money: two reads (the wallet only when the answer will not be a recovered
  // draft) and one coded row per answer that ends the wait (none for `pending`).
  if (action === "calibrate_style_ai_recover") {
    // The style exactly as calibrate_style_ai writes it into `style_key`: the same String(), the
    // same 120-character cut, and no trim, or a style whose key has a trailing space finds nothing.
    const styleKey = String(payload.styleValue ?? "").slice(0, 120);
    if (!styleKey) return json({ error: "styleValue is required." }, 400);
    // The key exactly as the insert and wallet_hold cut it (draftIdemKey).
    const idemKey = draftIdemKey(payload.idempotencyKey);
    if (!idemKey) return json({ error: "idempotencyKey (the press's own key) is required." }, 400);
    if (!userId) return json({ error: "Sign in again to pick your draft up." }, 401);
    // Not an answer about the draft, so never `pending: false`: the shell keeps asking.
    const unreadable = async (what: string, message: string) => {
      await logEdgeError({
        fn: "portal-settings", req, clientId, code: "ai_draft_recover_failed",
        message: `Could not read ${what} to pick a draft up: ${message}`,
      });
      const failed = json({ error: "We could not check on your draft just now." }, 503);
      filedAtReturnSite.add(failed);
      return failed;
    };
    const { data: rows, error: recErr } = await admin.from("ai_style_calls")
      .select(DRAFT_RECOVER_COLUMNS)
      .eq("client_id", clientId).eq("user_id", userId).eq("idem_key", idemKey).eq("style_key", styleKey)
      .in("source", ["video", "combined"])
      .order("called_at", { ascending: false })
      .limit(DRAFT_RECOVER_MAX_ROWS);
    if (recErr) return await unreadable("the ledger (migration 253 may not be applied)", recErr.message);
    const row = pickRecoverRow(rows as DraftRecoverRow[] | null);
    // The money, whenever the answer will not be a recovered draft (isRecoverableDraft: the same
    // test recoverDraftAnswer makes), so an unreadable draft on a charged press is said as charged.
    // A draft to hand back is the answer whatever the wallet says. The press's own debit rows
    // under the same key (wallet_hold's p_idem).
    let money: DraftMoney = { kind: "none" };
    if (!isRecoverableDraft(row)) {
      const { data: tx, error: txErr } = await admin.from("wallet_transactions")
        .select(DRAFT_RECOVER_MONEY_COLUMNS)
        .eq("client_id", clientId).eq("idempotency_key", idemKey).eq("actor_user_id", userId)
        .eq("meter_kind", "video_3d_generation").eq("kind", "debit");
      if (txErr) return await unreadable("the wallet", txErr.message);
      money = draftMoneyState(tx as DraftRecoverMoneyRow[] | null);
    }
    const out = recoverDraftAnswer(row, money, Date.now());
    if (out.kind === "draft") {
      await logEdgeError({
        fn: "portal-settings", req, clientId, code: out.code, severity: out.severity,
        message: "A streamed draft whose answer never reached the browser was picked up from the ledger.",
        context: { checkId: row?.id ?? null, calledAt: row?.called_at ?? null, frameMap: out.body.frameMap !== null },
      });
    } else if (out.kind === "lost") {
      await logEdgeError({
        fn: "portal-settings", req, clientId, code: out.code, severity: out.severity,
        message: `A streamed draft could not be picked up from the ledger (${out.why}).`,
        context: { why: out.why, money: money.kind, checkId: row?.id ?? null, calledAt: row?.called_at ?? null, draftMs: row?.draft_ms ?? null },
      });
    }
    return json(out.body);
  }

  // Draft a 3D spec from reference photos with Claude. The builder reviews and tunes the
  // result before anything is saved — this only ever returns a draft.
  //
  // Capped per tenant per day because it spends real money per call and is now reachable
  // by any owner/admin rather than by whoever holds the operator password. The ledger row
  // is written BEFORE the model call on purpose: a failing style would otherwise be a free
  // retry loop against our API key.
  //
  // The whole branch is ONE function of `streamed` (2026-09-25), answered by draftAnswer above: run
  // as it is for every request but a streamed v2 draft, and behind a heartbeat for that one.
  if (action === "calibrate_style_ai") return await draftAnswer(req, payload, { requestStartMs, clientId }, async (streamed: boolean): Promise<Response> => {
    // Two callers, one action, one gate, one meter. `source: "video"` means the URLs are
    // frames the browser cut out of a walk-around video (the file itself never leaves the
    // phone) rather than four staged photos — so it takes eight of them and a prompt that
    // knows the roof was only ever seen from the ground.
    //
    // The cap is a PARAMETER and not a bigger default because sanitizePhotoUrls slices
    // silently: send eight against the 4-default and you get HTTP 200, a full-price ledger
    // row, and a spec drafted from the first half of the walk. The response reports
    // `frames` for exactly that reason — a truncation that shows up in the UI is a bug you
    // can see, and this one otherwise looks like the model simply reading the shed wrong.
    // 'combined' (2026-09-07, Ahsan: "I want the users to upload the video and images both
    // after that we generate the 3D model") reads a walk-around's frames AND the builder's
    // own photos in one call. It takes the VIDEO prompt, because a combined set still
    // contains the walk-around and that prompt is the one that knows the roof was only ever
    // seen from the ground — the single most important thing about this input.
    //
    // TWELVE is Carolyn's own number, 09-04 @13:53: "three from the back, three from this
    // side, one three from this side, and three from this side."
    //
    // A walk alone takes WALK_FRAME_MAX since 2026-09-24 (12, was 8): the self-check now compares
    // the back and the far side too, and a lap of eight saw each side once. Combined stays 12 in
    // TOTAL, frames and photos together. Each frame is image tokens, so this is also a cost change.
    const fromVideo = payload.source === "video";
    const combined = payload.source === "combined";
    const shapeFirst = fromVideo || combined;
    const photoUrls = sanitizePhotoUrls(payload.photoUrls, combined ? 12 : fromVideo ? WALK_FRAME_MAX : 4);
    // How many of the leading URLs are walk-around frames. Clamped to what actually survived the
    // sanitiser: a caller claiming ten frames out of a set the cap cut to eight would otherwise
    // have the prompt describe two photographs that are not there.
    const videoCount = Math.max(0, Math.min(photoUrls.length, Math.floor(Number(payload.videoCount) || 0)));
    if (photoUrls.length === 0) return json({ error: "At least one photo URL is required." }, 400);
    // ── THE BUILDER'S OWN MEASUREMENTS (2026-09-19) ────────────────────────────────────────
    // Parsed HERE, beside the other input check and BEFORE the ledger row and the wallet hold,
    // because a refusal after either of those costs a daily-cap slot or $20 for a typo. Absent
    // is not an error: production runs an older browser bundle that has never heard of `dims`
    // and every one of its requests lands on `{ ok: true, dims: null }`, which is byte-identical
    // behaviour to yesterday all the way down to the prompt object.
    const dimsRead = parseKnownDims(payload.dims);
    if (!dimsRead.ok) return json({ error: dimsRead.error }, 400);
    // shapeFirst ONLY, and this is a real restriction rather than a tidy-up. SPEC_PROMPT has no
    // dims variant and is out of scope (brief section 8): the photo path feeds the scan card,
    // which replaces the AI's roof with a MEASURED one. Handing it dims would mean writing a
    // wall height into a spec whose roof is about to be overwritten anyway, and the echo below
    // reports what was USED, so a photos-source caller that sent dims is told plainly that they
    // were not.
    const dims = shapeFirst ? dimsRead.dims : null;
    // ── THE ROLLOUT GATE (2026-09-24, see wantsV2Prompt) ──────────────────────────────────────
    // Production's older browser bundle calls this same function and already sends dims, typed
    // against a card that says the width is "across the gable end". The v2 prompt reads them in
    // the NEW frame (the FRONT wall), so it goes ONLY to a request that says `frame: "front"` —
    // the new designer's — and has dims. Every other request takes exactly the prompt it took
    // before v2 existed, dims ruler and all, and none of v2's checks (the wings agreement below).
    const v2Prompt = wantsV2Prompt(payload.frame, dims);
    // ⚠️ TRUNCATION IS THE FAILURE MODE THAT LOOKS LIKE A BAD MODEL. sanitizePhotoUrls slices
    // SILENTLY, so an over-cap request returns HTTP 200, a full-price ledger row, and a spec
    // drafted from part of the set — and the builder concludes the AI reads sheds badly. The
    // caller is told what was actually read, for every source and not just video, so the UI
    // can say so instead of guessing from a constant it has to keep in step by hand.
    const sentCount = Array.isArray(payload.photoUrls) ? payload.photoUrls.filter(Boolean).length : 0;
    const droppedCount = Math.max(0, sentCount - photoUrls.length);
    const apiKey = Deno.env.get("ANTHROPIC_API_KEY");
    if (!apiKey) return json({ error: "AI drafting isn't configured yet (ANTHROPIC_API_KEY is unset)." }, 500);

    // PER-TENANT SINCE 227. The 10 was hard-coded from 086 and is the right shape for a real
    // builder — nobody calibrates one style eleven times in a day by accident — and the wrong
    // shape for the tenant we DEVELOP on, which burned all ten in an afternoon building this
    // very feature and then refused the eleventh press while the meter was disarmed, so the cap
    // was protecting nothing. Ahsan, 2026-09-11: "unlimited limit for only structure studio".
    //
    // ⛔ The tenant is NOT named here. `client_settings` is where per-tenant policy lives and is
    // SERVICE-ROLE ONLY, so a tenant can neither read nor raise their own cap — the same posture
    // as `billing_exempt`. A client id in an `if` branch would make one tenant special inside
    // code every tenant runs, and the second exemption would add a second branch.
    //
    // NULL = the default below. 0 = UNLIMITED. n = that many per rolling 24 hours.
    //
    // ⚠️ AN UNLIMITED CAP IS NOT A FREE PASS: `wallet_hold` below is untouched, so an unlimited
    // tenant with an armed meter still pays $20 a generation. Raising the cap moves the spend
    // limit onto the WALLET BALANCE and nothing else.
    const DEFAULT_DAILY_CAP = 10;
    const { data: capRow, error: capCfgErr } = await admin.from("client_settings")
      .select("ai_style_daily_cap").eq("client_id", clientId).maybeSingle();
    if (capCfgErr) {
      // Fail to the DEFAULT, not to unlimited: an unreadable setting must never widen a spend
      // cap. This is the opposite posture to the count below, and deliberately so — that one
      // failing open costs cents, this one failing open costs whatever the wallet holds.
      await logEdgeError({
        fn: "portal-settings", req, clientId, code: "ai_style_cap_config_failed",
        message: `Could not read ai_style_daily_cap, using the default: ${capCfgErr.message}`,
      });
    }
    const rawCap = capRow?.ai_style_daily_cap;
    const dailyCap = (typeof rawCap === "number" && rawCap >= 0) ? rawCap : DEFAULT_DAILY_CAP;
    // Unlimited skips the COUNT entirely rather than running a query whose answer cannot matter.
    if (dailyCap > 0) {
      const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
      const { count: used, error: capErr } = await admin.from("ai_style_calls")
        .select("id", { count: "exact", head: true })
        .eq("client_id", clientId).gt("called_at", since);
      // Fail OPEN on a broken count (capture-lead's posture): a cap that cannot be read must
      // not brick calibration, and the per-call cost is cents.
      if (capErr) {
        await logEdgeError({
          fn: "portal-settings", req, clientId, code: "ai_style_cap_count_failed",
          message: `AI calibration cap count failed, allowing the call: ${capErr.message}`,
        });
      } else if ((used ?? 0) >= dailyCap) {
        return json({ error: `Daily limit reached (${dailyCap} AI drafts). Tune the sliders by hand, or try again tomorrow.` }, 429);
      }
    }
    // CHECKED on purpose: this row IS the spend cap. Unchecked, a failed insert (table
    // drift, RLS change) still let the model call proceed -- unmetered spend on exactly the
    // path the ledger exists to meter (audit 2026-08-19). Refusing is the safe side; the
    // cap query above already failed soft for the read case.
    //
    // ── THE PRESS'S KEY RIDES ON ITS ROW (253, 2026-09-25) ────────────────────────────────────
    // `idem_key` is the key wallet_hold files this press's hold under (draftIdemKey: the same
    // String() and 120-character cut, used for both), so calibrate_style_ai_recover can find THIS
    // press's row, and its money, after a dropped stream -- by key, never by time. Production's
    // older shell sends a key too, so its rows simply get the column filled. A request with no key
    // (the photos path's older callers) inserts exactly the object it always did.
    //
    // ⚠️ A MISSING COLUMN MUST NEVER FAIL A GENERATION. This insert IS the spend cap and a failure
    // here is a 503, so a deploy landing before 253 would refuse every press. PostgREST refuses the
    // whole statement when one key names a column it cannot find (PGRST204), so on ANY failure with
    // the key in it the insert is tried once more without it -- the dims write below (247) does the
    // same -- and one info row names the migration. A second failure is the ledger really being
    // down, and refuses exactly as before. Without the key the row cannot be picked up after a drop
    // (the recover action answers no_row), which is the price of a migration not applied yet.
    const idemKey = draftIdemKey(payload.idempotencyKey);
    const ledgerInsert: Record<string, unknown> = { client_id: clientId, user_id: userId ?? null, style_key: String(payload.styleValue ?? "").slice(0, 120) || null, source: combined ? "combined" : fromVideo ? "video" : "photos" };
    let { data: ledgerRow, error: ledgerErr } = await admin.from("ai_style_calls").insert(idemKey ? { ...ledgerInsert, idem_key: idemKey } : ledgerInsert).select("id").single();
    if (ledgerErr && idemKey) {
      await logEdgeError({
        fn: "portal-settings", req, clientId, code: "ai_style_idem_key_write_failed", severity: "info",
        message: `Could not record the press's key on its ledger row - retrying without it; migration 253 may not be applied: ${ledgerErr.message}`,
      });
      ({ data: ledgerRow, error: ledgerErr } = await admin.from("ai_style_calls").insert(ledgerInsert).select("id").single());
    }
    if (ledgerErr) return json({ error: "The AI drafting meter is unavailable right now - try again shortly." }, 503);

    // ── WALLET HOLD ────────────────────────────────────────────────────────────────
    // Ordered deliberately: the API-key check, then the daily cap, then the ai_style_calls
    // row, THEN the money, then the model call.
    //
    //   * the key check first, or we hold $20 against a call that cannot happen;
    //   * the daily cap before the hold, because it bounds OUR exposure even for a paying
    //     tenant and a runaway loop must not churn hold/release pairs;
    //   * the hold last, immediately before the fetch, so the window in which money is
    //     reserved is as small as it can be.
    //
    // ⚠️ THE WALLET FAILS CLOSED. This is the INVERSE of everything else in this codebase
    // and the inversion is deliberate. Entitlement fails open (CLAUDE.md) because a
    // transient error must never paywall a paying customer, and that costs nothing. The
    // daily-cap count above fails open for the same reason. Failing open on a WALLET means
    // performing a $20 service free, spending real Anthropic dollars, and having no record
    // of either. Failing closed costs one blocked generation with an honest message, on a
    // feature that is optional and occasional. A reader who has internalised "entitlement
    // fails open" will want to fix this; do not.
    //
    // Only the VIDEO path charges. Ahsan, 2026-08-25: "when a 3D model is created using
    // the uploaded video". The $20 is priced off the video's Anthropic cost, and the photo
    // path is slated for removal.
    let holdId: number | null = null;
    // CHARGED FOR COMBINED TOO (2026-09-07). 129 rode the charge on video alone for two
    // reasons, and migration 206's header records both and why they no longer hold: the
    // photo path is no longer 'slated for removal' (it came back on 09-04 at Carolyn's
    // request), and pricing the accurate option higher is backwards from what she asked
    // for. One press is one hold is one charge, whichever inputs it read.
    if (shapeFirst) {
      const { data: hold, error: holdErr } = await admin
        .rpc("wallet_hold", { p_client_id: clientId, p_kind: "video_3d_generation", p_idem: idemKey, p_user: userId ?? null })
        .maybeSingle() as { data: any; error: any };
      if (holdErr) {
        await logEdgeError({ fn: "portal-settings", req, clientId, code: "wallet_hold_failed", message: `Wallet hold failed, refusing the generation: ${holdErr.message}` });
        return json({ error: "The billing meter is unavailable right now - please try again shortly." }, 503);
      }
      const err = hold?.err ?? null;
      if (err === "insufficient_funds") {
        // Clean up the cap row: it recorded a call that will not happen, and would
        // otherwise burn one of their ten free daily drafts on a refusal.
        if (ledgerRow?.id) await admin.from("ai_style_calls").delete().eq("id", ledgerRow.id);
        return json({
          error: `This 3D generation costs $${((hold?.price_cents ?? 2000) / 100).toFixed(2)} and your wallet has $${((hold?.balance_after ?? 0) / 100).toFixed(2)}. Add funds in Settings → Billing.`,
          code: "insufficient_funds",
          priceCents: hold?.price_cents ?? null,
          balanceCents: hold?.balance_after ?? null,
        }, 402);   // 402 matches portal-billing's decline status
      }
      if (err === "hold_in_flight") {
        if (ledgerRow?.id) await admin.from("ai_style_calls").delete().eq("id", ledgerRow.id);
        return json({ error: "A 3D generation is already running for this account - wait for it to finish." }, 409);
      }
      // ⚠️ PAID ALREADY, FOR THIS EXACT PRESS. New in migration 248, and unreachable until it
      // is applied. The browser mints one idempotency key per press and keeps it until a draft
      // lands, so a press whose reply never arrived — a dropped connection, a gateway 504 after
      // wallet_capture — retries under the same key. That is the idempotency working: the money
      // was taken once and must not be taken again.
      //
      // What was wrong was the sentence. Before 248, wallet_hold could not tell this apart from
      // a concurrent press and said "a 3D generation is already running - wait for it to
      // finish", forever, for a generation that finished and was charged for.
      //
      // ⚠️ AND THE DRAFT REALLY IS LOST, so the message must not pretend otherwise. It is on
      // the ledger row, but nothing reads it back: openCalEditor seeds from building_styles.d3,
      // which is only written on Save. So the honest answer is what it costs to try again, said
      // before they press rather than after. (calibrate_style_ai_recover, 2026-09-25, reads
      // `drafted` back off the row by the press's key, but only for a press whose STREAMED answer
      // dropped, while the page that sent it is still open. A press that reaches this line is a
      // new press that got this answer, and its own row is deleted just below.)
      //
      // No capture and no release: there is no live hold here, only a posted row.
      if (err === "hold_replayed") {
        if (ledgerRow?.id) await admin.from("ai_style_calls").delete().eq("id", ledgerRow.id);
        await logEdgeError({
          fn: "portal-settings", req, clientId, code: "wallet_hold_replayed", severity: "info",
          message: "A generation was retried under the key of one that had already been charged; no second hold was taken.",
          context: { shapeFirst, ledgerRow: ledgerRow?.id ?? null },
        });
        return json({
          error: "We already charged you for this generation and could not get the answer back to you, so the draft is gone. You have NOT been charged twice - this press took no money. Reload this page before pressing Generate again, or it will keep refusing; the next press will be a new charge.",
          code: "already_charged",
        }, 409);
      }
      if (err === "meter_unknown") {
        await logEdgeError({ fn: "portal-settings", req, clientId, code: "wallet_meter_missing", message: "usage_prices has no video_3d_generation row" });
        return json({ error: "The billing meter is unavailable right now - please try again shortly." }, 503);
      }
      // `meter_inactive` is the ARMING RAIL, not a failure: the migration seeds the price
      // with active = false so this function can be deployed and proven a no-op before one
      // boolean turns the charge on. holdId stays null and the generation runs free.
      if (!err) holdId = hold?.hold_id ?? null;

      // ── AUTO-RECHARGE (migration 164) ────────────────────────────────────────────────
      // The balance just dropped, which is the ONLY moment it can newly fall below the
      // tenant's threshold — so the check lives here rather than in a cron. The point is to
      // top up BEFORE they run dry, not to rescue a refusal.
      //
      // FAIL-SOFT, absolutely. This runs after the hold has succeeded and the generation is
      // authorised; a declined card, an unreachable gateway or a bad config must not fail a
      // generation the builder has already paid for out of existing balance. Everything in
      // here is swallowed.
      //
      // KNOWN GAP, deliberate: this does NOT fire on `insufficient_funds` above. A builder
      // who is already at zero when they press Generate still gets the refusal, and their
      // recharge happens on the next successful hold. Recharging inside a refusal path would
      // mean charging a card as part of an error response, then retrying the hold — a second
      // money path guarded by nothing, to save one retry. Not worth it.
      //
      // Awaited rather than backgrounded: EdgeRuntime.waitUntil only ASKS the runtime to keep
      // the worker (the streamed draft's heartbeat uses it for the work behind its answer), and a
      // money path is the wrong place to lean on a request — a task dropped on shutdown mid-sale
      // leaves a closed_unknown that blocks ALL future top-ups.
      // Cost is up to nmiPost's 30s on a request that is already running an AI 3D generation,
      // and the cooldown caps it at once an hour.
      try {
        const [{ data: acct }, { data: cust }] = await Promise.all([
          admin.from("wallet_accounts")
            .select("balance_cents, held_cents, auto_topup_enabled, auto_topup_threshold_cents, auto_topup_amount_cents, auto_topup_last_at")
            .eq("client_id", clientId).maybeSingle(),
          admin.from("billing_customers").select("vault_id").eq("client_id", clientId).maybeSingle(),
        ]);
        // Bind the vault id BEFORE the decision so its presence is provable rather than
        // implied: autoTopupDecision refuses without a card, but the type checker cannot know
        // that, and a non-null assertion on a money path is a comment pretending to be code.
        const vaultId = cust?.vault_id ? String(cust.vault_id) : "";
        const decision = autoTopupDecision(acct, Boolean(vaultId), Date.now());
        if (decision.fire && vaultId) {
          // Stamp the cooldown BEFORE charging, not after. A burst of generations can cross
          // the threshold several times in seconds; the failure to design against is five
          // recharges, not a late one. If the charge then fails, the stamp costs at most an
          // hour's delay before the next attempt.
          await admin.from("wallet_accounts")
            .update({ auto_topup_last_at: new Date().toISOString() }).eq("client_id", clientId);
          const r = await chargeTopup(admin, {
            clientId, vaultId, amountCents: decision.amountCents,
            actorUserId: null, auto: true,
          });
          if (!r.ok && !r.blocking) {
            // A DECLINE switches auto-recharge off rather than retrying hourly forever. An
            // expired card declines identically every time, and a loop against it earns real
            // declines on the merchant account. The Billing tab shows this reason; turning it
            // back on is a human act.
            await admin.from("wallet_accounts")
              .update({ auto_topup_enabled: false, auto_topup_disabled_reason: String(r.error).slice(0, 300) })
              .eq("client_id", clientId);
            await logEdgeError({ fn: "portal-settings", req, clientId, code: "auto_topup_declined", message: `Auto top-up declined, switched off: ${r.error}` });
          } else if (!r.ok) {
            // Blocking (gateway-unknown, or charged-but-not-credited). Leave it ENABLED:
            // the closed_unknown attempt row already blocks every further top-up, and
            // support's reconciliation is what should restore normal service — switching it
            // off here would make a resolved incident look like a card problem.
            await logEdgeError({ fn: "portal-settings", req, clientId, code: "auto_topup_unresolved", message: `Auto top-up needs a human: ${r.error}` });
          }
        }
      } catch (e) {
        await logEdgeError({ fn: "portal-settings", req, clientId, code: "auto_topup_crashed", message: `Auto top-up check failed (generation unaffected): ${(e as Error).message}` })
          .catch(() => undefined);
      }
    }

    // From here on, every exit path must either capture or release the hold. A generation
    // that fails is not the builder's fault and must not cost them $20 -- and a release is
    // a local decrement of a number that never moved, where a refund would be a second
    // mutation that can itself fail (see portal-billing's void/refund/closed_unknown
    // ladder, which exists precisely because that is hard).
    const releaseHold = async (reason: string) => {
      if (holdId == null) return;
      const { error } = await admin.rpc("wallet_release", { p_hold_id: holdId, p_reason: reason });
      if (error) await logEdgeError({ fn: "portal-settings", req, clientId, code: "wallet_release_failed", message: `Could not release hold ${holdId}: ${error.message}` });
    };

    // ── THE MODEL CALL: bounded in tokens AND in time (2026-09-17) ──────────────────────
    // The model thinks adaptively, and max_tokens caps thinking and the answer TOGETHER. The
    // old 700/900 left a few hundred tokens beyond the JSON, so a reply that thought first
    // could run out before writing it. 8000 gave the thinking room; effort "medium" keeps
    // its depth (and latency) in check without switching it off, which the gambrel knee
    // arithmetic in the shape prompt benefits from.
    //
    // 12000 SINCE 2026-09-24. One 09-21 generation in twelve was cut at 8000 after 103 s, and the
    // v2 prompt asks for more (the front, the shed's high side, wings, the porch's height and
    // width, three more colours, six frame-map views) out of more frames. At the ~78 tokens/s
    // measured that day, 12000 is ~154 s — past the abort below. That is deliberate: the abort is
    // the real bound on a runaway reply, and it is a clean, released, RETRYABLE failure; the
    // budget only has to stop being the thing a normal long reply trips over.
    //
    // 20000 ON A STREAMED DRAFT ONLY (2026-09-25). At effort "high" a read thinks for longer, and a
    // read that thinks past 12000 is cut off unparsed however much of its 230 s is left. Every
    // other request keeps 12000, byte for byte. What it can cost: three reads of ~21,000 input and
    // at most 20,000 output tokens at Opus's list price (aiDraftCostCents) is at most ~$1.82 a
    // press, against ~$1.22 at 12000 -- recorded as the capture's cost basis, never charged to the
    // builder, whose price is the held $20 whatever the tokens.
    //
    // The timeout is the other half. Supabase's gateway answers 504 on its own at 150 s of
    // silence, and that 504 is invisible to withErrorLog and leaves the wallet hold open until
    // the stale sweep. 125 s (110 s until 2026-09-24) still leaves room to release the hold and
    // say so. The same signal covers the body read, which is why the body is read inside this
    // try: a reply that stalls mid-body is a timeout, not an "unparseable" spec.
    //
    // ⚠️ BOUNDED BY THE GATEWAY, MEASURED FROM THE REQUEST (fix, 2026-09-24; re-cut 2026-09-25).
    // The auto top-up above runs inline and can spend up to nmiPost's 30 s before this line, so a
    // 125 s clock started here let a slow top-up plus a slow reply cross the gateway's 150 s: the
    // builder got a bare 504 (no `retryable`, so no lean retry) while this function went on to
    // CAPTURE the $20 for a draft nobody would see.
    //
    // The first fix took the pre-call time out of the MODEL's 125 s, which cut every request short
    // by its own set-up, and cut a top-up's by up to 30 s -- production's older designer included,
    // which has no lean retry to fall back on. A 103 s legacy reply (the 09-21 log has them) that
    // finished at ~133 s, inside the gateway, was aborted at ~95 s. So the model keeps its 125 s and
    // only the GATEWAY's clock is charged for the set-up: 145 s from the request (requestStartMs,
    // the handler's first line), leaving 5 s to release the hold, file the row and answer. That is
    // the whole 125 s whenever the set-up took 20 s or less, which is every request without a slow
    // top-up; past 20 s the model gets what is left of 145 s. Never under 60 s: a floor only a set-up
    // over 85 s could reach, which nothing before this line can take.
    //
    // `lean: true` is the new browser's ONE automatic retry after a `retryable` failure (a cut-off
    // or timed-out reply): same press, same idempotency key — the failed attempt released its hold,
    // and a released key is reusable (248) — at effort "low", which thinks less and so fits. Only a
    // real `true` counts; an older browser never sends it and keeps effort "medium".
    //
    // ⚠️ A STREAMED DRAFT HAS NO 150 s GATEWAY (2026-09-25, see draftAnswer): its answer is a 200 that
    // has been writing a space every 10 s since the request arrived. What bounds it instead is the
    // platform's wall clock, which let a probe run 220 s; the whole request stays under ~260 s. So
    // the model gets 230 s, or what is left of 260 s from the request after a slow set-up, and never
    // under 60 s: the same rule as below with the gateway's 145 s replaced by 260 s. Every request
    // that is not streamed keeps exactly the rule below.
    const lean = payload.lean === true;
    // The reads' effort, decided once: "low" on the lean retry, "high" on a streamed draft, "medium"
    // on everything else (see output_config below for why). The request carries it, and so does
    // draft_tokens, so "which effort did this draft run at, and was it streamed" is a query.
    const draftEffort = lean ? "low" : streamed ? "high" : "medium";
    const aiSource = combined ? "combined" : fromVideo ? "video" : "photos";
    const t0 = Date.now();
    const draftAbortMs = streamed
      ? Math.max(60_000, Math.min(230_000, 260_000 - (t0 - requestStartMs)))
      : Math.max(60_000, Math.min(125_000, 145_000 - (t0 - requestStartMs)));

    // ── WHAT THE DRAFT CALL USED, on every exit that reached the model (251, 2026-09-23) ──────
    // Until now a draft's tokens were stored only through wallet_capture, and the meter is
    // inactive for every tenant, so no successful draft's usage or latency had ever been kept.
    // One 09-21 press was cut off at max_tokens after 103 s, and without these two columns there
    // is no telling whether the other eleven finished at 3,000 tokens or at 7,900.
    //
    // ⚠️ ITS OWN UPDATE, never a key on the 226 `recorded` write below. PostgREST refuses the
    // WHOLE statement when one key names a column it cannot find (PGRST204), so a deploy landing
    // before 251 would otherwise lose drafted/observed/frames on every generation too.
    //
    // BEST-EFFORT, and it cannot reject: diagnostics must never fail or change what the builder
    // gets back. Called WITHOUT await where it starts, so the round trip overlaps the hold
    // release, the log row and the rest of the handler; each exit awaits it just before its
    // `return`, because a task still running after the response is not guaranteed to finish
    // (EdgeRuntime.waitUntil is a request, not a promise — see the auto-recharge note above). `draft_ms` is
    // read when it is CALLED, which is the moment the reply (or the abort) arrived; with several
    // calls (consensus drafting, below) the moment the last of them settled, so it is the
    // builder's wall time, and each call's own time is in draft_tokens.calls.
    //
    // aiDraftUsageWiring_test lifts the body below and RUNS it, so keep it plain JavaScript:
    // the only type annotation is on this first line, which the test uses as its anchor.
    //
    // `effort` and `streamed` (2026-09-25) ride at the top of the object, beside the counts, so
    // streamed drafts at "high" can be told from the rest in SQL without a new column. A null
    // (a single call that got no reply) stays null: that is what "no reply" means in this column.
    const recordDraftUsage = async (tokens: Record<string, unknown> | null) => {
      if (!ledgerRow?.id) return;
      try {
        const { error } = await admin.from("ai_style_calls")
          .update({ draft_tokens: tokens ? { ...tokens, effort: draftEffort, streamed } : tokens, draft_ms: Date.now() - t0 }).eq("id", ledgerRow.id);
        if (error) {
          await logEdgeError({
            fn: "portal-settings", req, clientId, code: "ai_style_draft_usage_log_failed",
            message: `Could not record the draft call's usage; migration 251 may not be applied: ${error.message}`,
          });
        }
      } catch (e) {
        // Never the builder's problem, but never silent either: a throw here (a refactor's
        // TypeError, say) would stop usage recording with nothing to show for it, which is the
        // blind spot this write exists to close. logEdgeError itself never rejects.
        await logEdgeError({
          fn: "portal-settings", req, clientId, code: "ai_style_draft_usage_log_failed",
          message: `Draft-usage write threw: ${String(e instanceof Error ? e.message : e)}`,
        });
      }
    };

    const aiSignal = AbortSignal.timeout(draftAbortMs);
    // ── THE REQUEST, BUILT ONCE (2026-09-25) ─────────────────────────────────────────────────
    // Outside the call, so consensus drafting (below) can send the very same bytes more than once.
    // The body is the object the single call has always sent, key for key and in the same order,
    // so a legacy or lean request is byte-for-byte what it was: aiDraftConsensusWiring_test builds
    // the expected string on its own and compares.
    const draftInit = {
      method: "POST",
      // v2 (the new designer) runs Opus; legacy keeps Sonnet — see aiModelFields in
      // styleD3.ts for the measurement behind the switch.
      headers: { "content-type": "application/json", "x-api-key": apiKey, "anthropic-version": "2023-06-01" },
      body: JSON.stringify({
        ...aiModelFields(v2Prompt),
        // Thinking and the answer share this. The video prompt's `observed` block rides on
        // top of the spec. A truncated reply is unparseable, not partially useful. More room only
        // on a streamed draft, which thinks at "high" (see above).
        max_tokens: streamed ? 20000 : 12000,
        thinking: { type: "adaptive" },
        // v2 thinks HARD (2026-09-25). At "medium", Opus often answered a walk-around in 10-15 s with
        // ~480 output tokens -- the JSON and next to no thinking -- and those shallow reads put a
        // shed's high side on the wrong wall 6 times in 7 and read a 16 ft porch as 10-12 ft with 3
        // posts; the reads that did think (3,400-5,400 tokens) got both right. "high" makes every
        // read a careful one. Legacy keeps "medium"; the lean retry keeps "low".
        // ⚠️ ONLY WHEN STREAMED: tried live 2026-09-25 on the plain request, all three reads ran past
        // the 125 s draft budget (the gateway ends a silent request at 150 s), so every press fell to
        // the lean retry. A streamed draft (draftAnswer: the new shell's v2 press) outlives the
        // gateway with a 230 s budget and thinks "high"; a v2 request that is NOT streamed keeps
        // "medium" and its 125 s, with the reads' reasoning carried in the reply itself (the prompt's
        // evidence fields). `streamed` is never true with `lean` (wantsStreamedDraft). The choice is
        // draftEffort, above, so draft_tokens records the very effort this request sent.
        output_config: { effort: draftEffort },
        messages: [{
          role: "user",
          content: [
            // URL sources: the photos live in public buckets, so Anthropic can fetch them
            // and we never proxy the bytes through this function.
            ...photoUrls.map((url) => ({ type: "image", source: { type: "url", url } })),
            // A combined set gets a prompt that says which images are walk frames and which are
            // staged photographs. Until 2026-09-10 it got VIDEO_SHAPE_PROMPT verbatim, whose
            // first sentence claims every image is a consecutive frame of one lap - false the
            // moment a builder's own photos are appended, and false in a way that changes how
            // the model reconciles the views it is shown.
            // `dims` rides on both shape-first prompts and on neither of them when it is null:
            // videoShapePrompt(null) IS the old VIDEO_SHAPE_PROMPT constant and a two-argument
            // combinedShapePrompt is byte-identical to what shipped, so a request without dims
            // sends exactly the string it sent before this line changed.
            // v2Prompt (the rollout gate): the v2 prompt only for the new designer's frame.
            { type: "text", text: combined ? combinedShapePrompt(videoCount, photoUrls.length - videoCount, dims, v2Prompt) : (fromVideo ? videoShapePrompt(dims, v2Prompt) : SPEC_PROMPT) },
          ],
        }],
      }),
    };

    // ── CONSENSUS DRAFTING (2026-09-25) ──────────────────────────────────────────────────────
    // Live v2 runs of one video give the same shape every time and wandering numbers: a raised
    // centre's eave read 15, 14 and 12.5 ft, the pitch anywhere from 0.37 to 0.7, 3 porch posts or
    // 4, the steps in the centre or on the right. So the v2 draft sends the SAME request three
    // times in parallel and combines the reads (consensusDrafts in styleD3.ts: the medoid read is
    // the base, every discrete field goes by majority, every number is the median of the reads
    // that agree with the structure chosen for it).
    //
    //   * ONE budget. draftAbortMs above bounds all three together, never each. Once two have
    //     drafted, the third gets DRAFT_CONSENSUS_GRACE_MS (60 s) more and is then cut off.
    //   * A call that fails, is cut off or does not parse is dropped. One read that parses is
    //     enough to answer with; the consensus of one read is that read.
    //   * NONE parsed: the FIRST call SENT (not the first to come back) is classified exactly the
    //     way the single call always was, by the exits below, with the hold released as before.
    //   * ONE call, exactly today's request and handling: every legacy request (production's
    //     older designer) and the lean retry (draftCallCount). runDraftCalls sends a lone call on
    //     aiSignal itself.
    //
    // THE LEAD is the call this branch answers from: the medoid's call when any call drafted, so
    // the `observed` notes and the frame map read off `text` below are the medoid's own, and
    // otherwise the first call sent.
    const draftCalls = draftCallCount(v2Prompt, lean);
    const calls = await runDraftCalls({
      count: draftCalls,
      deadline: aiSignal,
      graceMs: DRAFT_CONSENSUS_GRACE_MS,
      send: (signal) => fetch("https://api.anthropic.com/v1/messages", { ...draftInit, signal }),
      read: (body) => readDraftReply(body, dims),
    });
    // How many walk frames a frame map may point into (see the note beside frameMap, below).
    // Declared here because the consensus parses every read's map, not only the lead's.
    const walkFrames = combined ? videoCount : photoUrls.length;
    const consensus = draftCalls > 1 ? consensusOfCalls(calls, walkFrames) : null;
    const lead = consensus ? calls[consensus.call] : calls[0];
    // What EVERY call used, for draft_tokens and the capture. Null on a single call, whose usage is
    // recorded exactly as it always has been, at each exit below.
    const callsUsage = draftCalls > 1 ? draftCallsUsage(aiModelFields(v2Prompt).model, calls, lead, consensus) : null;
    if (lead.threw) {
      // No reply to describe on any of these three exits, so draft_tokens stays null (on a single
      // call; several record what each call did); draft_ms still says how long the press waited
      // before it gave up.
      const usageLogged = recordDraftUsage(callsUsage ? callsUsage.tokens : null);
      if (lead.aborted === "deadline") {
        // Ours, not the network's: the signal fired while this call was waiting (read the moment
        // it threw, so a first call that failed on its own at 5 s is not relabelled a timeout by
        // the other two running out the clock). Release first, then file one coded row and mark
        // the response so withErrorLog does not add a generic copy of it.
        await releaseHold("model timeout");
        await logEdgeError({
          fn: "portal-settings", req, clientId, code: "ai_call_timeout",
          message: "The AI model did not answer within the time limit.",
          context: { elapsedMs: Date.now() - t0, requestMs: Date.now() - requestStartMs, abortMs: draftAbortMs, source: aiSource, frames: photoUrls.length, lean },
        });
        // `retryable: true` (2026-09-24) is the machine-readable half of "please try again": the
        // hold is released, so the same press may go again under the same key, and the new
        // browser does exactly that ONCE, with `lean: true`. An older browser ignores the field and
        // shows the sentence, exactly as before.
        const timedOut = json({ error: "The AI took too long to answer - please try again.", retryable: true }, 504);
        filedAtReturnSite.add(timedOut);
        await usageLogged;
        return timedOut;
      }
      await releaseHold("fetch failed");            // never reached Anthropic, or dropped mid-reply
      await usageLogged;
      return json({ error: `Could not reach the AI service: ${lead.error instanceof Error ? lead.error.message : String(lead.error)}` }, 502);
    }
    if (!lead.httpOk) {
      const usageLogged = recordDraftUsage(callsUsage ? callsUsage.tokens : null);
      await releaseHold(`upstream ${lead.status}`);  // our 429/500 is not the builder's fault
      await usageLogged;
      return json({ error: `AI service returned ${lead.status}: ${lead.body.slice(0, 300)}` }, 502);
    }
    // Read ONCE, inside runDraftCalls: readDraftReply is the JSON parse and modelReplyText that ran
    // here before (every text block joined, never content[0] -- see modelReplyText for why).
    const data = lead.reading.data;
    const reply = lead.reading.reply;
    const text = reply.text;
    // SHAPES ONLY in the failure rows below: no reply text, no image URLs. Enough for the next
    // failure to name its own cause (thinking used the budget, a refusal, a prose reply) and
    // for elapsedMs to show how close real calls come to the timeout.
    // `textChars` is the answer's LENGTH, never its text: outputTokens counts thinking and the
    // answer together, and this is what tells "thinking used the budget" from "the JSON did".
    const replyShape = {
      stopReason: reply.stopReason, blockTypes: reply.blockTypes, outputTokens: reply.outputTokens,
      textChars: text.length, elapsedMs: Date.now() - t0, source: aiSource, frames: photoUrls.length,
      // Whether this was the lean automatic retry — so a truncated retry is a query, not a guess.
      lean,
      // Which prompt the rollout gate chose: v2 (the new designer's frame) or the legacy one.
      v2: v2Prompt,
    };
    // ── DRAFT USAGE: started here, awaited at each of the three returns below ─────────────
    // Every outcome that got a reply passes through this line — refused, truncated, unparseable
    // and drafted alike — so the column's distribution is the whole population, not the failures.
    // Counts come off `usage` and are null where it did not say; nothing here carries model text.
    // Several calls (consensus drafting) record callsUsage instead: the same keys summed over every
    // call, plus one entry per call, the reads' roofs and the agreement report (draftCallsUsage).
    const draftUsage = data?.usage ?? {};
    const draftUsageLogged = recordDraftUsage(callsUsage ? callsUsage.tokens : {
      // Which model ran (2026-09-25), so the cost basis can be re-priced per model later.
      model: aiModelFields(v2Prompt).model,
      input: Number.isFinite(draftUsage.input_tokens) ? draftUsage.input_tokens : null,
      output: Number.isFinite(draftUsage.output_tokens) ? draftUsage.output_tokens : null,
      cache_read: Number.isFinite(draftUsage.cache_read_input_tokens) ? draftUsage.cache_read_input_tokens : null,
      cache_creation: Number.isFinite(draftUsage.cache_creation_input_tokens) ? draftUsage.cache_creation_input_tokens : null,
      stopReason: reply.stopReason,
      textChars: text.length,
      blockTypes: reply.blockTypes,
    });
    if (reply.stopReason === "refusal") {
      await releaseHold("model refused");
      const category = typeof data?.stop_details?.category === "string" ? String(data.stop_details.category).slice(0, 60) : null;
      await logEdgeError({
        fn: "portal-settings", req, clientId, code: "ai_spec_refused",
        message: "The AI model declined to draft a spec from these images.",
        context: { ...replyShape, category },
      });
      const refused = json({ error: "The AI declined to read these images. Try a different set, or set the shape by hand." }, 502);
      filedAtReturnSite.add(refused);
      await draftUsageLogged;
      return refused;
    }
    // The builder's numbers go over the model's INSIDE parseModelSpec, between the inches fold
    // and the sanitiser — see its header for why that is the only position that works.
    const drafted = parseModelSpec(text, dims);
    if (!drafted.ok) {
      // The model answered unusably. The builder got nothing, so charging for our own
      // parse failure buys a support ticket and teaches them not to trust the feature.
      // A reply cut off at max_tokens gets its own code and sentence, so neither the edge row
      // nor the portal's mirror of this response reads as a reply that never came.
      const truncated = reply.stopReason === "max_tokens";
      await releaseHold(truncated ? "reply truncated" : "unparseable spec");
      await logEdgeError({
        fn: "portal-settings", req, clientId,
        code: truncated ? "ai_spec_truncated" : "ai_spec_unparseable",
        message: truncated ? `Model reply was cut off at max_tokens: ${drafted.error}` : `Model reply did not parse: ${drafted.error}`,
        context: replyShape,
      });
      // A cut-off reply is `retryable` (2026-09-24), like the timeout above: the hold is released
      // and a lean retry thinks less, so it usually fits. An UNPARSEABLE reply is not marked: the
      // same prompt on the same frames tends to fail the same way, and an automatic retry of it
      // would spend a second model call on a known failure.
      const failed = json(truncated
        ? { error: "The AI ran out of room before finishing - please try again.", retryable: true }
        : { error: drafted.error }, 502);
      filedAtReturnSite.add(failed);
      await draftUsageLogged;
      return failed;
    }
    // THE CONSENSUS TAKES THE LEAD'S PLACE here, and only here. Every exit above answered from the
    // lead's own reply (a medoid always drafted, so none of them is reachable with a consensus);
    // everything below (the capture, the flags, the ledger's `drafted`, the response) takes the
    // combined spec.
    if (consensus) drafted.d3 = consensus.d3;

    // ── HOW THE OVERHANG IS FRAMED: NOT ASKED FOR, AND NOT WRITTEN DOWN EITHER ─────────
    // Neither prompt mentions overhangStyle, and that is the point rather than an oversight.
    // The walk-around camera never leaves the ground (VIDEO_SHAPE_PROMPT says so in its own
    // second numbered point), so the roof is only ever a silhouette — and a notched tail is an
    // UNDERSIDE distinction, the one thing that viewpoint cannot show. Ask for it and the model
    // answers anyway, from nothing.
    //
    // A first cut derived it from the overhang HERE and set it on the sanitised spec. That is
    // deleted: the overhang the model DID read off the silhouette is already stored, and
    // d3OverhangStyle derives the framing from it in the renderer every time it draws. Writing
    // the derived answer into the draft would freeze it, after which a builder correcting the
    // overhang in the calibration panel would no longer re-frame the eave.

    // ── CAPTURE ────────────────────────────────────────────────────────────────────
    // Token usage was previously PARSED AND DISCARDED. Storing it is what makes "do tell
    // me how much it does use" (Carolyn, 2026-08-24) answerable from one query instead of
    // a guess. Note Anthropic FETCHES the frames from our public bucket URLs, so image
    // tokens dominate input_tokens and the per-generation cost scales with SS_VID_FRAMES --
    // a future "more frames = better spec" tweak is also a cost change, and this is what
    // makes that visible rather than surprising.
    let balanceCents: number | null = null;
    if (holdId != null) {
      // Consensus drafting paid for EVERY call that answered, so the cost basis is their sum
      // (draftCallsUsage: Anthropic's keys, summed, with `calls`). A single call is exactly as before.
      const u = callsUsage ? callsUsage.usage : (data?.usage ?? null);
      const inTok = Number(u?.input_tokens ?? 0), outTok = Number(u?.output_tokens ?? 0);
      // OUR cost basis, not a tenant-facing price, by the model this request ran (aiDraftCostCents,
      // 2026-09-25: the v2 path runs Opus and was recorded at Sonnet's rate). The legacy path's
      // number is exactly what it always was. The tokens are stored raw, and draft_tokens.model
      // says which model ran, so a rate correction can be applied retrospectively.
      const costCents = aiDraftCostCents(v2Prompt, inTok, outTok);
      const { data: bal, error: capErr2 } = await admin.rpc("wallet_capture", {
        p_hold_id: holdId, p_cost_cents: Math.round(costCents), p_usage: u, p_ref_id: String(ledgerRow?.id ?? ""),
      });
      if (capErr2) {
        // The generation SUCCEEDED and we could not take the money. Do not fail the
        // request over it -- the builder has their model. Record it loudly instead; the
        // hold will age out and auto-release, which is the safe direction for them.
        await logEdgeError({ fn: "portal-settings", req, clientId, code: "wallet_capture_failed", message: `Hold ${holdId} not captured after a successful generation: ${capErr2.message}` });
      } else {
        balanceCents = typeof bal === "number" ? bal : null;
        if (ledgerRow?.id) await admin.from("ai_style_calls").update({ charged_cents: 2000, wallet_tx_id: holdId }).eq("id", ledgerRow.id);
      }
    }

    // A gambrel whose two slopes are nearly the same angle draws as a plain gable (2026-09-16).
    // FLAGGED, not refused: the builder reviews before Save, and a refusal would throw away the
    // porch, colours and notes the same reply got right. The warning rides in `observed`, which
    // the panel already shows. Charged either way: the model answered and the rest is usable.
    //
    // shapeFirst ONLY, on purpose. The photos source is the scan card's, and that card replaces
    // the AI's roof with the scan's MEASURED one (scanApplyMeasured) and never reads `observed`,
    // so a warning there would describe a roof nobody sees and pollute the flagged-draft query.
    //
    // The PORCH check joins it on 2026-09-19 (see porchAgreementWarning). Same posture, same
    // place, and deliberately the same call: the prompt now forces `observed.porch` to one of
    // three words, so the reply can be checked against the roof it drafted in the same breath.
    // Both warnings compose in `roofNote` — a draft can be wrong about the roof AND the porch,
    // and the builder needs to be sent to look at both. Parsed ONCE into `observedRead`,
    // because the agreement check reads the same notes that are about to be flagged.
    //
    // This reaches PRODUCTION's older browser bundle with no frontend change, which is the
    // whole reason the warning rides in `roofNote` rather than in a new response field.
    //
    // knownDimsNote joins them on the same day as dims themselves. It is silent unless a wall
    // height the BUILDER typed had to be clamped to what the renderer can draw — the one way
    // their own measurement can still lose, and the one the preview cannot explain by itself.
    //
    // The WINGS check joins them on 2026-09-24, for v2 generations ONLY — the ones the rollout
    // gate sent the v2 prompt (v2Prompt: frame "front" and dims), because only that prompt asks
    // observed.wings. On every legacy path the question was never put, so the check would say "the
    // reading never said" on every generation and turn every draft amber. Same posture as the
    // porch check otherwise: flagged, never repaired.
    //
    // THE FRAME-KEY CHECK leads them (fix, 2026-09-24), v2 ONLY for the same reason: the v2 prompt
    // makes roof.front (gable, gambrel) and roof.highSide (shed) REQUIRED, and a draft without
    // them is drawn in the old frame -- on a long-fronted building, turned round -- so it is the
    // first thing the builder is sent to look at, and the draft comes back low-confidence.
    //
    // THE SPLIT CHECK joins them with consensus drafting (2026-09-25): a discrete field no two of
    // the reads agreed on (1 of 3, or 1 of 2) is named, so the builder is told where the reads split
    // and the draft comes back low-confidence. A 2-of-3 majority says nothing. Only when there is a
    // consensus, which is v2 only; the checks around it read the combined spec and the medoid's notes.
    const observedRead = shapeFirst ? parseObservedNotes(text) : null;
    const observedNotes = shapeFirst
      ? flagObservedNotes(observedRead, v2Prompt ? frameKeyWarning(drafted.d3.roof) : null, gambrelRoofWarning(drafted.d3.roof), porchAgreementWarning(drafted.d3.roof, observedRead), v2Prompt ? wingsAgreementWarning(drafted.d3.roof, observedRead) : null, consensus ? consensusSplitWarning(consensus.report) : null, knownDimsNote(dims))
      : null;

    // ── WHICH FRAME GOES WITH WHICH VIEW (2026-09-19) ────────────────────────────
    // Read out of the same reply, at no extra call. Nothing here reaches the spec —
    // sanitizeD3Spec drops it — so an older browser that ignores the field behaves exactly as it
    // does today. Since 253 it is also kept on the ledger row (`frame_map`, its own write below),
    // so a draft picked up after its connection dropped can still run the free self-check.
    //
    // ⚠️ THE BOUND IS HOW MANY WALK FRAMES WERE SENT, not how many images were. On `combined`
    // the browser says so and the trailing images are the builder's own photographs, which must
    // never come back captioned as a walk-around view. On `video` every image in the set IS a
    // frame — that is the prompt's opening sentence — so the bound is the whole array, which
    // also keeps the legacy onDraftFromVideo caller working: it sends no videoCount at all, and
    // taking `videoCount` there would bound every index to zero and drop the whole map.
    // (`walkFrames` is declared beside the model call, since consensus drafting parses every
    // read's map with the same bound.)
    const frameMap = shapeFirst ? parseFrameMap(text, walkFrames) : null;
    // The token for the free follow-up check, and only where a check can happen. The row id is a
    // uuid, so it is unguessable, and the claim that spends it is scoped to this client_id as
    // well — handing it to the browser that just paid for the row gives away nothing it does not
    // already own. A photos generation gets null rather than a token for an action that would
    // refuse it: a capability for something that cannot happen is an invitation to a 409.
    const checkId = shapeFirst ? (ledgerRow?.id ?? null) : null;

    // ── THE FRAME MAP, KEPT FOR A DRAFT PICKED UP AFTER A DROP (253, 2026-09-25) ────────────────
    // The free self-check cannot pair a render with a frame without it, and until 253 it lived only
    // in the answer: a streamed draft whose answer dropped came back through
    // calibrate_style_ai_recover with no map, and the check was skipped. Now the recover action
    // hands the row's own map back and the check runs as it does on a live answer.
    //
    // ⚠️ ITS OWN UPDATE, BEFORE `drafted` IS WRITTEN, so a pickup that sees the draft sees its map
    // too. And nothing here can reach the write below: a column that is missing (253 not applied),
    // a write that fails or a throw costs the MAP and never the draft, and never the builder's
    // answer -- one info row, and the recovered draft skips the check with a note, exactly as
    // every draft did before 253. No map (a photos draft, a reply that carried none) is no write,
    // so those requests keep yesterday's round trips.
    if (ledgerRow?.id && frameMap) {
      try {
        const { error: mapErr } = await admin.from("ai_style_calls").update({ frame_map: frameMap }).eq("id", ledgerRow.id);
        if (mapErr) {
          await logEdgeError({
            fn: "portal-settings", req, clientId, code: "ai_style_frame_map_write_failed", severity: "info",
            message: `Could not keep the frame map on the generation; migration 253 may not be applied: ${mapErr.message}`,
          });
        }
      } catch (e) {
        await logEdgeError({
          fn: "portal-settings", req, clientId, code: "ai_style_frame_map_write_failed", severity: "info",
          message: `Frame-map write threw: ${String(e instanceof Error ? e.message : e)}`,
        });
      }
    }

    // ── RECORD WHAT IT SAID, not just that it ran (226) ───────────────────────────────────
    // The drafted spec goes back to the browser and lands in an in-memory draft. Unless the
    // builder then presses Save it exists NOWHERE ELSE — so on 2026-09-10/11 three generations
    // ran, none was saved, and every "it is not accurate" report had to be diagnosed from a
    // screenshot and a description. Now a generation can be read back whatever the builder
    // does next, which is the difference between diagnosing accuracy and guessing at it.
    //
    // BEST-EFFORT, on purpose: this is diagnostics, and a builder who has already been charged
    // must never lose their draft because a logging write failed. Both values are already
    // sanitised — sanitizeD3Spec is a whitelist rebuild capped at 4KB, parseObservedNotes keeps
    // known keys at 240 chars each — so nothing unbounded reaches the table.
    if (ledgerRow?.id) {
      const recorded = {
        drafted: drafted.d3,
        observed: observedNotes,
        frames: photoUrls.length,
        video_count: videoCount,
      };
      // ⚠️ `dims` IS GUARDED, because its column arrives in a migration this code must not
      // depend on having been applied. PostgREST refuses the WHOLE statement when one key names
      // a column it cannot find (PGRST204), so adding `dims` to the object above would mean that
      // between this deploy and 247 landing, every generation ALSO lost `drafted`, `observed`
      // and `frames` — the exact blind spot 226 was written to close, reopened by a diagnostics
      // field. The write is attempted with dims and retried without on any failure, and the two
      // failures carry different codes so "247 is not applied yet" is a query and not a guess.
      //
      // With no dims the payload and the round-trip count are byte-identical to yesterday, which
      // is what every production request gets: its browser has never heard of dims.
      //
      // Written out twice rather than through a little `write(row)` helper, deliberately: that
      // helper needed a TypeScript parameter annotation, and this block is LIFTED VERBATIM and
      // RUN by aiLedgerDimsWiring_test, which parses it as plain JavaScript. A test that had to
      // strip types out of the source first would be testing its own regex as much as the guard.
      let { error: logErr } = await admin.from("ai_style_calls")
        .update(dims ? { ...recorded, dims } : recorded).eq("id", ledgerRow.id);
      if (logErr && dims) {
        await logEdgeError({
          fn: "portal-settings", req, clientId, code: "ai_style_dims_write_failed",
          message: `Could not record dims on the generation - retrying without them; migration 247 may not be applied: ${logErr.message}`,
        });
        ({ error: logErr } = await admin.from("ai_style_calls")
          .update(recorded).eq("id", ledgerRow.id));
      }
      if (logErr) {
        await logEdgeError({
          fn: "portal-settings", req, clientId, code: "ai_style_result_log_failed",
          message: `Could not record the drafted spec: ${logErr.message}`,
        });
      }
    }

    // `frames` makes a silent truncation visible; `observed` is the builder-facing note
    // about doors, windows and vents, which the spec has no field for; `balanceCents` lets
    // the panel show the new balance without a second round trip.
    //
    // `dims` is ECHOED AS USED, not as sent: null when none arrived, null when they arrived on
    // a source that has no dims prompt, and the parsed numbers otherwise. Same reason `frames`
    // is echoed — a caller that has to infer what the server did from what it sent is a caller
    // that will one day infer it wrong. An older browser ignores the field.
    //
    // `frameMap` and `checkId` are the two the free self-check needs and nothing else reads yet:
    // which of the images it just sent goes with which view, and the token for the follow-up
    // request. Both are null on a photos generation and both are simply ignored by a browser
    // that has never heard of them, which is every production browser.
    //
    // The draft-usage write started beside replyShape and has had the whole capture and ledger
    // write to finish; this is the last point it can be waited on before the response goes.
    await draftUsageLogged;
    return json({ ok: true, d3: drafted.d3, frames: photoUrls.length, dropped: droppedCount, observed: observedNotes, balanceCents, dims, frameMap, checkId });
  });

  // ── THE FREE SECOND PASS (2026-09-19) ──────────────────────────────────────────────────
  // The builder pressed Generate once, was held once and charged once, and has their draft.
  // This is what happens next: the browser renders that draft from a few camera angles, puts
  // each render beside the builder's own frame of the same view, and asks the model where its
  // own draft does not match the building. Free, and single-use.
  //
  // ⚠️ THE MONEY LADDER IS NOT TOUCHED HERE. No cap check, no ledger insert, no wallet_hold, no
  // wallet_capture. One press is one hold is one charge, and this action exists on the other
  // side of that sentence: it spends about four cents of our own Anthropic budget on a draft
  // that has already been paid for, and it cannot be made to spend it twice.
  //
  // WHAT MAKES IT SINGLE-USE is one statement: a conditional UPDATE that sets `self_check_at`
  // only while it is still null and returns the row it touched. No row back means the check has
  // already run, the row is not this tenant's, it is not this style's, or it is older than the
  // window — all four answered with a 409 before any model call. `returning` rather than
  // read-then-write, because two presses landing together would both pass a read.
  //
  // THE CLAIM IS WRITTEN BEFORE THE MODEL CALL, deliberately. A transient failure therefore
  // BURNS the check rather than opening a retry loop: there is no path in this function that
  // calls the model twice for one generation. The builder keeps the draft either way, which is
  // what makes burning it the cheap direction.
  //
  // ⛔ NOTHING THE CALLER SENDS BECOMES AN INPUT TO THE MODEL EXCEPT THE RENDER BYTES. The draft
  // and the builder's measurements are read back off the claimed row; the frames are the style's
  // own stored URLs. Handing the browser those inputs would turn one $20 generation into a free
  // vision call on any twelve images on the internet with caller-written text spliced into the
  // prompt — `sanitizePhotoUrls` accepts any https URL and is not bucket-scoped.
  //
  // ── UP TO THREE ROUNDS (v2, 2026-09-24; migration 252) ──────────────────────────────────
  // The browser can now re-render the corrected spec and ask again, up to SELF_CHECK_MAX_ROUNDS
  // times per generation. Every rail above still holds, per round:
  //   * ONE CLAIM PER ROUND, and the claim is still one conditional UPDATE with `returning`: a
  //     compare-and-swap on `self_check_round` (k -> k+1). Round 0 ALSO requires `self_check_at`
  //     to be null, which is today's single-use claim verbatim — a request with no `round` is
  //     round 0, so production's older browser gets exactly the one check it always had, and
  //     its second request is still a 409.
  //   * A LATER ROUND ONLY AFTER CORRECTIONS. Round k > 0 is claimable only while the row's
  //     verdict says the round before it applied corrections, and its claim clears the verdict
  //     until it records its own. So the server stops on matches / failed / skipped / rejected
  //     whatever a browser does, and two rounds can never be in flight at once.
  //   * THE ROW, NEVER THE CALLER. Round k > 0 judges `self_check_after ?? drafted` read off the
  //     claimed row, and states the ruler from the row's `dims`, exactly as round 0 does.
  //   * The 15-minute window, the tenant and style filters, the kill switch, the render caps and
  //     the frame whitelist are unchanged, and no round touches money.
  if (action === "calibrate_style_check") {
    const t0 = Date.now();
    const styleValue = String(payload.styleValue ?? "").trim();
    const checkId = String(payload.checkId ?? "").trim();
    if (!styleValue) return json({ error: "styleValue is required." }, 400);
    // Shape-checked here rather than left to Postgres: `.eq("id", "not-a-uuid")` comes back as
    // 22P02 from the driver, which would read as a database fault in app_errors and answer 500
    // to what is plainly a bad request.
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(checkId)) {
      return json({ error: "checkId is required." }, 400);
    }
    // ── THE ROLLOUT GATE, FOR THE CHECK TOO (fix, 2026-09-24; see selfCheckMode) ─────────────
    // The new designer sends `frame: "front"` on every check, exactly as on every draft, and only
    // that request gets the v2 check. Every other request -- production's older designer, which
    // sends neither `frame` nor `round` -- gets d3ab404's check byte for byte: its prompt, its
    // 22-path allow-list and six-field cap, its four viewpoints and render caps, its budget, and
    // its response shape. Until this line the v2 check (new-frame ruler, massing step, 30 paths)
    // reached that designer too, and could save roof.front, highSide and the wing keys into a
    // style its renderer cannot draw and its panel cannot clear. Decided before anything else,
    // because the round limit and the render caps below both depend on it.
    const checkMode = selfCheckMode(payload.frame);
    const v2Check = checkMode === "v2";
    // WHICH ROUND. Absent is round 0. A round past the limit is refused here, before anything
    // touches the database, with the same 409 code a spent claim gets — one rule for a browser.
    // A legacy check has ONE round: d3ab404's single-use check.
    const roundRead = parseSelfCheckRound(payload.round, v2Check ? SELF_CHECK_MAX_ROUNDS : 1);
    if (!roundRead.ok) {
      return json({ error: roundRead.error, ...(roundRead.code ? { code: roundRead.code } : {}) }, roundRead.status);
    }
    const round = roundRead.round;
    const apiKey = Deno.env.get("ANTHROPIC_API_KEY");
    if (!apiKey) return json({ error: "AI drafting isn't configured yet (ANTHROPIC_API_KEY is unset)." }, 500);

    // A CHECK THAT DOES NOT RUN IS NOT AN ERROR. The builder has their draft; the only thing
    // they lose is a free second opinion, so every one of these answers 200 with a verdict the
    // panel can render as one quiet line. A 4xx here would make the panel show a failed
    // generation, which is the one thing that never happened.
    // The round fields are v2's; a legacy answer is d3ab404's, key for key.
    const skipped = (reason: string, note: string) =>
      json({ ok: true, verdict: "skipped", reason, note, changed: [], checked: {}, d3: null, renders: 0, ...(v2Check ? { round, roundsLeft: 0 } : {}) });

    // BEST-EFFORT, like the 226 write above and for the same reason: the builder has already
    // been charged and already holds their draft, and a diagnostics failure must never be the
    // thing that takes either away. No missing-column guard, unlike the `dims` write: all eight
    // columns arrive in migration 247 together and `self_check_at` is the CLAIM, so without 247
    // this action refuses before it ever reaches here.
    // deno-lint-ignore no-explicit-any
    const recordSelfCheck = async (id: string, row: Record<string, any>) => {
      const { error } = await admin.from("ai_style_calls").update(row).eq("id", id);
      if (error) {
        await logEdgeError({
          fn: "portal-settings", req, clientId, code: "ai_selfcheck_log_failed",
          message: `Could not record the self-check result: ${error.message}`,
        });
      }
    };

    // ── EACH ROUND'S LINE IN THE HISTORY (v2, migration 252) ──────────────────────────────
    // `self_check_rounds` is an array with one entry per round, {round, verdict, changed, ms,
    // tokens, renders}, so "what did round 2 do?" survives round 3 overwriting the scalar
    // columns. ITS OWN UPDATE, like 251's usage write, so a fault here can never take the
    // verdict write (which is what unlocks the next round) down with it; best-effort, with one
    // coded row. GUARDED ON THE ROUND COUNTER: it lands only while the row is still at this
    // round's claim, so a late write can never overwrite a later round's history.
    //
    // Read-modify-write is safe here and only here because rounds are serialised: the next
    // round cannot be claimed until this round's verdict is written, and this is written first.
    // `roundsBefore` is the array as the claim's RETURNING saw it.
    let roundsBefore: unknown = null;
    // deno-lint-ignore no-explicit-any
    const appendRound = async (entry: Record<string, any>) => {
      const prior = Array.isArray(roundsBefore) ? roundsBefore : [];
      const { error } = await admin.from("ai_style_calls")
        .update({ self_check_rounds: [...prior, { round, ...entry }].slice(-SELF_CHECK_MAX_ROUNDS) })
        .eq("id", checkId).eq("client_id", clientId).eq("self_check_round", round + 1);
      if (error) {
        await logEdgeError({
          fn: "portal-settings", req, clientId, code: "ai_selfcheck_rounds_log_failed",
          message: `Could not record self-check round ${round + 1} in self_check_rounds: ${error.message}`,
          context: { checkId, round },
        });
      }
    };

    // THE CHECK FAILED AND THE GENERATION DID NOT. Every one of these paths ends with the
    // builder holding the first draft, told that the CHECK could not run — never that their
    // $20 generation failed. One coded row each, so "how often does the second call time out?"
    // is a query rather than a feeling, and the claim stays spent, which is what stops a failing
    // check becoming a retry loop against our own API key. A failed round also ENDS the rounds:
    // its verdict is not "corrections", so the next round's claim finds no row.
    const failedCheck = async (code: string, message: string, context: Record<string, unknown>) => {
      await logEdgeError({ fn: "portal-settings", req, clientId, code, message, context });
      await appendRound({
        verdict: "failed", changed: [], ms: Date.now() - t0,
        tokens: context.tokens ?? null, renders: Number(context.renders ?? 0),
      });
      await recordSelfCheck(checkId, {
        self_check_verdict: "failed",
        self_check_renders: Number(context.renders ?? 0),
        self_check_ms: Date.now() - t0,
        ...(context.tokens ? { self_check_tokens: context.tokens } : {}),
      });
      return json({
        ok: true, verdict: "failed", reason: code, changed: [], checked: {}, d3: null,
        renders: Number(context.renders ?? 0),
        note: "We couldn't finish checking the draft against your video - review it yourself before saving.",
        ...(v2Check ? { round, roundsLeft: 0 } : {}),
      });
    };

    // The array of images the FIRST call was given, re-sent so the frame indices mean something.
    // ⚠️ POSITIONS ARE ALL THAT IS TAKEN FROM IT. Length-capped, never filtered: dropping a junk
    // entry would close the gap and shift every index after it, so a render aimed at image 6
    // would be paired with image 7 and look exactly like a right answer. Nothing in this array
    // reaches the model unless the STYLE itself stores it (selfCheckPairs, below).
    const sentUrls: string[] = (Array.isArray(payload.photoUrls) ? payload.photoUrls : [])
      .slice(0, 12)
      .map((u: unknown) => (typeof u === "string" ? u.trim() : ""));
    // Said plainly rather than left to surface as "the front render names image 1, which was not
    // in this generation" four lines down — which is true, and describes the wrong fault.
    if (!sentUrls.length) return json({ error: "photoUrls (the same set the generation read) is required." }, 400);

    // Refused, not truncated, and refused BEFORE the claim: a render over the cap is a fault in
    // the browser half of this feature, and burning the tenant's one check on it would hide the
    // fault behind a 409 the next time anyone looked. Nothing here reaches the model, so a
    // caller that keeps sending bad renders keeps getting 400s and spends nothing.
    // The mode's caps: four renders and 1.2 MB for a legacy check, six and 1.8 MB for v2.
    const rendersRead = parseSelfCheckRenders(payload.renders, sentUrls.length, checkMode);
    if (!rendersRead.ok) return json({ error: rendersRead.error }, 400);

    // ── THE KILL SWITCH, before the claim ────────────────────────────────────────────────
    // One Supabase project serves beta AND production and the promotion workflow is disabled,
    // so an edge deploy is live for every production builder the moment it lands. This is the
    // way to stop a bad check that is not a rollback and does not need a deploy. NULL = on.
    //
    // It FAILS CLOSED, which is the opposite of the daily-cap read in calibrate_style_ai above,
    // and the inversion is deliberate: that read guards money and must not paywall a paying
    // tenant, while this one is an emergency stop, and a stop that a transient database blip
    // defeats is not a stop. The cost of honouring it too often is one free improvement
    // skipped on a draft the builder already holds. Checked before the claim, so turning the
    // switch back on leaves every unclaimed row still checkable.
    const { data: swRow, error: swErr } = await admin.from("client_settings")
      .select("ai_style_self_check").eq("client_id", clientId).maybeSingle();
    if (swErr) {
      // ⚠️ THIS IS THE ROW A DEPLOY-BEFORE-247 PRODUCES, not the claim's. Migration 247 adds
      // `client_settings.ai_style_self_check` in the same file as the eight ai_style_calls
      // columns, and this select is the FIRST statement in this action to reach the database --
      // so with 247 unapplied PostgREST refuses it here and the claim below is never issued.
      // The migration is therefore named in this message, where it will be read, as well as in
      // the claim's. Anything watching for a bad deploy should grep
      // `code like 'ai_selfcheck%'` rather than any one of them.
      await logEdgeError({
        fn: "portal-settings", req, clientId, code: "ai_selfcheck_switch_unreadable",
        message: `Could not read ai_style_self_check, skipping the check; migration 247 may not be applied: ${swErr.message}`,
      });
      return skipped("switch_unreadable", "The check could not run just now - review the draft yourself.");
    }
    if (swRow?.ai_style_self_check === false) {
      return skipped("off", "The check is switched off for this account - review the draft yourself.");
    }

    // ── WHICH FRAMES MAY BE SHOWN ────────────────────────────────────────────────────────
    // The style's OWN two lists, and nothing else. This is the whitelist that turns "the caller
    // sends image URLs" into "the caller picks from images it already uploaded to this style".
    const found = await findStyleFor3D(styleValue, "");
    if (found.err) return found.err;
    const ownFrames = [...mediaList(found.style!.d3_video_frames), ...mediaList(found.style!.d3_photos)];
    const pairs = selfCheckPairs(sentUrls, ownFrames, rendersRead.renders);
    // Every render lost its frame. Comparing our own drawings with nothing is not a check, and
    // the model would answer anyway — so this stops here, before the claim, because the reason
    // is about the style's stored media rather than about this generation.
    if (!pairs.length) {
      return skipped("no_frames", "The check could not line your video frames up with the 3D - review the draft yourself.");
    }

    // ── THE CLAIM ────────────────────────────────────────────────────────────────────────
    // One statement does all of it: proves the row is this tenant's and this style's, proves it
    // is recent, proves no check has run on it, marks it used, and hands back the two things the
    // check needs. Scoping on `style_key` as well as `client_id` costs nothing and stops a
    // caller pairing one generation's draft with another style's frames — both its own, so not
    // a breach, but a comparison of two different buildings presented as one.
    const since = new Date(Date.now() - 15 * 60 * 1000).toISOString();
    // A COMPARE-AND-SWAP ON THE ROUND (v2). `self_check_round` counts the rounds claimed, so
    // round k is claimable only while it is exactly k, and claiming it makes it k+1 — two
    // requests for one round cannot both get a row back, and no round can ever run twice.
    //   * Round 0 is ALSO `self_check_at is null`, today's single-use guard verbatim. That is
    //     not redundant: a row checked by the pre-252 code has its round still at 0 (the
    //     default), and without this filter it would be checkable a second time.
    //   * Round k > 0 is ALSO `self_check_verdict = 'corrections'`, and its claim clears the
    //     verdict until the round records its own. So a round runs only after the one before
    //     it FINISHED and CHANGED something: matches, failed, skipped and rejected all end the
    //     rounds here on the server, and a second round cannot start while one is in flight.
    // `self_check_at` keeps 247's meaning, when the check was first claimed; only round 0
    // writes it.
    let claim = admin.from("ai_style_calls")
      .update(round === 0
        ? { self_check_at: new Date().toISOString(), self_check_round: 1 }
        : { self_check_round: round + 1, self_check_verdict: null })
      .eq("id", checkId).eq("client_id", clientId).eq("style_key", styleValue)
      .eq("self_check_round", round).gt("called_at", since);
    claim = round === 0
      ? claim.is("self_check_at", null)
      : claim.eq("self_check_verdict", "corrections");
    const { data: claimed, error: claimErr } = await claim
      .select("drafted, dims, self_check_after, self_check_changed, self_check_rounds").maybeSingle();
    if (claimErr) {
      // A database fault: a dropped connection, a statement timeout, a permission change — OR
      // MIGRATION 252 NOT APPLIED. This is the first statement in the action to name a 252
      // column (`self_check_round`), so a deploy-before-252 is refused HERE, on every check, and
      // this row names it. (247 is still told by the kill-switch read above, which runs first.)
      // Either way the failure is safe: the action cannot run unclaimed, which is why nothing
      // below needs its own missing-column guard.
      await logEdgeError({
        fn: "portal-settings", req, clientId, code: "ai_selfcheck_claim_failed",
        message: `Could not claim the check for this generation (if every check says this, migration 252 may not be applied): ${claimErr.message}`,
      });
      return skipped("unavailable", "The check could not run just now - review the draft yourself.");
    }
    if (!claimed) {
      return json({
        error: round === 0
          ? "That generation has already been checked, or it is too old to check now."
          : "That round of the check has already run, the round before it changed nothing, or the generation is too old to check now.",
        code: "check_unavailable",
      }, 409);
    }

    // ── THE RULER ────────────────────────────────────────────────────────────────────────
    // Read off the ROW, never off the request. Every measuring instruction in the check prompt
    // reads a length as a fraction of a wall of known height, so a check run without one would
    // measure the eave against a wall the model itself guessed — which the baseline says comes
    // back 7 ft on a 9 ft building in 74 % of generations. It would be wrong in the same
    // direction every time and would sound just as certain. Refusing is the honest answer.
    //
    // The claim has already been spent by the time we get here, and that is correct: a row with
    // no dims will never grow any, so leaving it claimable would only invite the same refusal
    // again. `self_check_verdict = 'skipped'` in the table means exactly this and nothing else.
    //
    // v2: THE SPEC A ROUND JUDGES IS THE ONE THE ROW HOLDS. Round 0 judges `drafted`, as it
    // always has (a round-0 row has no `self_check_after`). Round k > 0 judges what the round
    // before it produced, `self_check_after`, falling back to `drafted` where that round's net
    // effect was nothing. Never anything the browser sent: the renders it sent are of the spec
    // it holds, and this is what they are compared against. `drafted` is read either way, as
    // the fixed point every round's net change is measured from.
    roundsBefore = claimed.self_check_rounds ?? null;
    const rowDims = parseKnownDims(claimed.dims);
    const dims = rowDims.ok ? rowDims.dims : null;
    const draftRead = sanitizeD3Spec(claimed.self_check_after ?? claimed.drafted);
    const firstRead = round === 0 ? draftRead : sanitizeD3Spec(claimed.drafted);
    if (!dims || !draftRead.ok || !firstRead.ok) {
      const bad = !draftRead.ok ? draftRead : !firstRead.ok ? firstRead : null;
      const why = !dims
        ? "the generation recorded no measurements"
        : `the recorded draft could not be read back (${bad && !bad.ok ? bad.error : ""})`;
      // TWO SEVERITIES, because these are two different events wearing one code. A row with no
      // dims is the product correctly declining — `info`, the same posture every other refusal
      // takes, and it must never sit in the fault queue. A row whose `drafted` will not go back
      // through the sanitiser that produced it is a genuine fault and belongs there.
      await logEdgeError({
        fn: "portal-settings", req, clientId, code: "ai_selfcheck_row_unusable",
        severity: dims ? "error" : "info",
        message: `Self-check skipped: ${why}.`,
        context: { checkId, round, hasDims: !!dims, hasDraft: draftRead.ok && firstRead.ok },
      });
      await appendRound({ verdict: "skipped", changed: [], ms: Date.now() - t0, tokens: null, renders: 0 });
      await recordSelfCheck(checkId, { self_check_verdict: "skipped", self_check_renders: 0, self_check_ms: Date.now() - t0 });
      return skipped("row_unusable", "The check could not run on this generation - review the draft yourself.");
    }

    // ── THE SECOND CALL ──────────────────────────────────────────────────────────────────
    // The builder's frame first and our render second, one pair per viewpoint, with a line
    // naming which is which. Reality before our attempt at it. The whole request -- prompt,
    // pairs, model, max_tokens and abort -- is built by selfCheckRequest, so what each mode
    // sends is pinned on its bytes in styleD3.test.ts.
    //
    // THE BUDGET (SELF_CHECK_BUDGET). LEGACY: d3ab404's 45 s and 4000 tokens, well under call 1's
    // 125 s -- the builder already has their draft, so a slow check is worth abandoning. v2
    // (fix, 2026-09-24): 90 s and 8000 tokens. The v2 check reads up to twelve images against a
    // longer prompt, and at ~78 tokens/s 45 s bought ~3,500 tokens; a timeout ends the rounds,
    // which cut off exactly the massing corrections v2 exists for. The answer is still bounded at
    // eight fields, so the room is for thinking. ⚠️ The browser's own abort on this call must sit
    // above 90 s. If `self_check_tokens` shows replies stopping at max_tokens, move the budget.
    //
    // A later round is told it is one, and which fields the rounds before it changed —
    // allow-listed NAMES off the row's own self_check_changed, never the model's prose.
    const plan = selfCheckRequest({
      mode: checkMode, dims, draft: draftRead.d3, pairs,
      round, earlier: selfCheckChangedFields(claimed.self_check_changed),
    });
    const checkSignal = AbortSignal.timeout(plan.abortMs);
    let checkRes: Response;
    let checkBody = "";
    try {
      checkRes = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: { "content-type": "application/json", "x-api-key": apiKey, "anthropic-version": "2023-06-01" },
        signal: checkSignal,
        body: JSON.stringify(plan.body),
      });
      checkBody = await checkRes.text();
    } catch (e) {
      return await failedCheck(
        checkSignal.aborted ? "ai_selfcheck_timeout" : "ai_selfcheck_unreachable",
        checkSignal.aborted
          ? `The self-check did not answer within ${plan.abortMs / 1000} seconds.`
          : `Could not reach the AI service for the self-check: ${e instanceof Error ? e.message : String(e)}`,
        { elapsedMs: Date.now() - t0, renders: pairs.length },
      );
    }
    if (!checkRes.ok) {
      return await failedCheck("ai_selfcheck_upstream", `The self-check call returned ${checkRes.status}: ${checkBody.slice(0, 300)}`, {
        status: checkRes.status, elapsedMs: Date.now() - t0, renders: pairs.length,
      });
    }
    // deno-lint-ignore no-explicit-any
    let checkData: any = null;
    try { checkData = JSON.parse(checkBody); } catch { checkData = null; }
    const checkReply = modelReplyText(checkData);
    const usage = checkData?.usage ?? null;
    const tokens = { input: Number(usage?.input_tokens ?? 0), output: Number(usage?.output_tokens ?? 0) };
    if (checkReply.stopReason === "refusal") {
      return await failedCheck("ai_selfcheck_refused", "The model declined to compare these images.", {
        elapsedMs: Date.now() - t0, renders: pairs.length, tokens,
      });
    }
    const read = parseSelfCheck(checkReply.text, checkMode);
    if (!read) {
      return await failedCheck(
        checkReply.stopReason === "max_tokens" ? "ai_selfcheck_truncated" : "ai_selfcheck_unparseable",
        checkReply.stopReason === "max_tokens"
          ? "The self-check ran out of room before finishing its answer."
          : "The self-check reply did not parse.",
        { stopReason: checkReply.stopReason, blockTypes: checkReply.blockTypes, elapsedMs: Date.now() - t0, renders: pairs.length, tokens },
      );
    }

    // ── THE GATES ────────────────────────────────────────────────────────────────────────
    // Allow-list, field cap, both-lists, the porch exclusion and sanitizeD3Spec, all inside
    // applySelfCheck so they are testable without a network. The MODE picks the list and the
    // cap: d3ab404's 22 paths and six fields for a legacy check, 30 and eight for v2. `drafted`
    // is NOT touched by any of it: the first pass stays on the row or "did the check help?"
    // stops being answerable.
    // `dims` rides along so a builder who MEASURED the eave keeps it: roof.overhang comes off
    // the allow-list for that generation, the same way wallHeightFt and sizeFt are permanently
    // off it. selfCheckPrompt stops asking for it in the same breath.
    const applied = applySelfCheck(draftRead.d3, read, dims, checkMode);
    if (!applied.ok) {
      return await failedCheck("ai_selfcheck_merge_failed", applied.error, { elapsedMs: Date.now() - t0, renders: pairs.length, tokens });
    }
    // What the model asked for and did not get. An `info` row, not an error: dropping these IS
    // the product working. It is here because "is the check trying to repaint buildings?" should
    // be one query rather than a hunch, and because a model that has started ignoring the rules
    // is something to see early.
    if (applied.dropped.length) {
      await logEdgeError({
        fn: "portal-settings", req, clientId, code: "ai_selfcheck_field_dropped", severity: "info",
        message: `The self-check proposed ${applied.dropped.length} change(s) that were not applied.`,
        context: { checkId, verdict: applied.verdict, dropped: applied.dropped.slice(0, 20) },
      });
    }

    const elapsedMs = Date.now() - t0;
    // THE NET EFFECT, AGAINST THE FIRST DRAFT (v2). `applied.changed` is this round only, with
    // `from` read off the spec this round judged. `total` runs every line from `drafted` to
    // the final spec, so `self_check_changed` stays "what the check changed" however many rounds
    // it took. On round 0 the two are the same list, and round 0 writes `applied.changed` itself
    // so the check an older browser runs records exactly what it always did. `reverted` is the
    // fields this round put straight back where the draft had them: a flip-flop.
    const total = round === 0
      ? applied.changed
      : selfCheckTotalChanges(firstRead.d3, applied.d3, claimed.self_check_changed, applied.changed);
    const reverted = selfCheckReverted(total, applied.changed);
    // History FIRST, then the verdict: the verdict write is what makes the next round
    // claimable, so writing it last is what keeps the read-modify-write in appendRound serial.
    await appendRound({ verdict: applied.verdict, changed: applied.changed, ms: elapsedMs, tokens, renders: pairs.length });
    // `self_check_after` is written ONLY when something actually moved. A null there means the
    // draft stands, so diffing `drafted` against it stays the one query that answers what the
    // check changes across every tenant, with no rows that differ from `drafted` by nothing —
    // which is also why a later round that moves everything BACK writes null rather than a copy
    // of `drafted`. The scalar columns (verdict, tokens, renders, ms) describe the LATEST round;
    // `self_check_after` and `self_check_changed` the whole check; every round is in
    // `self_check_rounds`.
    await recordSelfCheck(checkId, {
      self_check_verdict: applied.verdict,
      self_check_changed: total,
      self_check_tokens: tokens,
      self_check_renders: pairs.length,
      self_check_ms: elapsedMs,
      ...(applied.verdict === "corrections" ? { self_check_after: total.length ? applied.d3 : null } : {}),
    });

    // The raw `corrections` object is deliberately NOT echoed. `d3` is the merged spec after all
    // three gates and `changed` is what actually moved, with `from` and `to` read off the two
    // specs rather than off the model's own account of them — a browser handed the raw object
    // would have its own fourth chance to apply something the gates just refused.
    //
    // A LEGACY check answers exactly as d3ab404 did, key for key (it is always round 0, where
    // `total` IS `applied.changed`): an older designer reads what it always read.
    if (!v2Check) {
      return json({
        ok: true,
        verdict: applied.verdict,
        d3: applied.verdict === "corrections" ? applied.d3 : null,
        changed: applied.changed,
        checked: read.checked,
        note: read.note,
        renders: pairs.length,
        ms: elapsedMs,
      });
    }
    //
    // v2 FIELDS, all additive (an older browser reads none of them):
    //   d3           round 0: exactly as before, the corrected spec only when something moved.
    //                Round k > 0: ALWAYS the cumulative spec (the draft plus every round that
    //                applied), because a later round can move a field BACK, and "null, keep what
    //                you have" would then leave the browser on a spec the row no longer holds.
    //   changedTotal every change against the FIRST draft, for "What the check changed".
    //   reverted     fields this round moved back to the draft's value: the flip-flop to stop on.
    //   round        which round this answered (0-based).
    //   roundsLeft   how many more rounds are worth asking for: 0 unless this round applied
    //                corrections without undoing an earlier one, and never past the limit. The
    //                server's own hard stops are the claim above, whatever this says.
    const roundsLeft = applied.verdict === "corrections" && !reverted.length
      ? Math.max(0, SELF_CHECK_MAX_ROUNDS - (round + 1))
      : 0;
    return json({
      ok: true,
      verdict: applied.verdict,
      d3: round === 0 ? (applied.verdict === "corrections" ? applied.d3 : null) : applied.d3,
      changed: applied.changed,
      changedTotal: total,
      reverted,
      checked: read.checked,
      note: read.note,
      renders: pairs.length,
      ms: elapsedMs,
      round,
      roundsLeft,
    });
  }

  // Reorder this tenant's building styles. `orderedIds` is the desired top-to-bottom order;
  // each style's sort_order is set to its index, which is what get_config / the designer sort
  // by (so the first id becomes the first style shown on the design page). Scoped to clientId.
  if (action === "reorder_styles") {
    if (!Array.isArray(payload.orderedIds) || payload.orderedIds.length === 0) return json({ error: "orderedIds[] required" }, 400);
    { const e = tooMany(payload.orderedIds, "items to reorder"); if (e) return json({ error: e }, 400); }
    let i = 0;
    for (const styleId of payload.orderedIds) {
      const sid = String(styleId ?? "").trim();
      if (!sid) continue;
      const { error } = await admin.from("building_styles")
        .update({ sort_order: i })
        .eq("client_id", clientId).eq("id", sid);
      if (error) return dbFail(req, clientId, "reorder your styles", error);
      i++;
    }
    return json({ ok: true });
  }

  // Full-replace this tenant's paint palette (Colors tab). Takes the COMPLETE desired list:
  // rows carrying an id are updated, rows without one are inserted, and any existing colour
  // absent from the list is deleted. A row that FAILS validation is skipped and its colour
  // kept as-is — a validation error must never escalate into deletion (audit 2026-08-20).
  // clientId is JWT-resolved (own tenant only). The designer is selection-only today
  // (get_config exposes label/siding/trim/allowCustom/isDefault/swatch, never a price);
  // rate/pricing_method are persisted here for a later paint-pricing pass.
  // Wall-height upgrades per building style (172). Full-replace for ONE style at a time: the
  // editor renders a card per style and saves that card, so a tenant with eight styles never
  // has to round-trip the other seven to change one. `styleId` scopes both the write and the
  // delete sweep, and is verified to belong to THIS tenant before either.
  if (action === "save_wall_heights") {
    const styleId = String(payload.styleId ?? "").trim();
    if (!styleId) return json({ error: "styleId required" }, 400);
    if (!Array.isArray(payload.rows)) return json({ error: "rows[] required" }, 400);
    { const e = tooMany(payload.rows, "rows"); if (e) return json({ error: e }, 400); }

    // The style must be this tenant's. clientId comes from the JWT, never the body, so this
    // is what stops a crafted styleId writing heights onto another builder's catalog.
    const stRes = await admin.from("building_styles").select("id").eq("client_id", clientId).eq("id", styleId).maybeSingle();
    if (stRes.error) return dbFail(req, clientId, "read that style", stRes.error);
    if (!stRes.data) return json({ error: "That building style is not in your catalog." }, 400);

    // The widths this style actually sells — used only to collapse an all-ticked list back to
    // null, so a later-added width is offered automatically rather than needing a re-tick.
    const szRes = await admin.from("building_sizes").select("width_ft").eq("client_id", clientId).eq("style_id", styleId).eq("active", true);
    if (szRes.error) return dbFail(req, clientId, "read that style's sizes", szRes.error);
    const allWidths = [...new Set((szRes.data ?? []).map((z: { width_ft: number }) => Number(z.width_ft)).filter((w) => Number.isFinite(w)))].sort((x, y) => x - y);

    const exRes = await admin.from("style_wall_heights").select("id").eq("client_id", clientId).eq("style_id", styleId);
    if (exRes.error) return dbFail(req, clientId, "read your current wall heights", exRes.error);
    const existingIds = new Set((exRes.data ?? []).map((r: { id: string }) => String(r.id)));
    const keptIds = new Set<string>();
    let saved = 0; const skipped: string[] = [];
    const seenDeltas = new Set<number>();
    let i = 0;
    for (const raw of payload.rows) {
      const row = raw as Record<string, unknown>;
      // KEPT before validated — the save_colors invariant. A row that fails validation must be
      // reported as skipped and LEFT ALONE, never swept by the delete below.
      const rid = String(row?.id ?? "").trim();
      const isExisting = rid !== "" && existingIds.has(rid);
      if (isExisting) keptIds.add(rid);
      const unchanged = isExisting ? " — existing row left unchanged" : "";

      const deltaIn = Number(row?.deltaIn);
      if (!Number.isInteger(deltaIn) || deltaIn <= 0 || deltaIn > 48) {
        skipped.push(`row ${i}: "${row?.deltaIn}" is not a whole number of inches between 1 and 48${unchanged}`); i++; continue;
      }
      if (seenDeltas.has(deltaIn)) { skipped.push(`+${deltaIn} in: listed twice${unchanged}`); i++; continue; }
      seenDeltas.add(deltaIn);

      // Refuse, never coerce — the rate posture everywhere in this file. A blank rate is a
      // deliberate "offer it later": the row is stored unpriced and get_config withholds it.
      const rateRaw = String(row?.ratePerLf ?? "").trim();
      let ratePerLf: number | null = null;
      if (rateRaw !== "") {
        const n = Number(rateRaw);
        if (!Number.isFinite(n) || n < 0) { skipped.push(`+${deltaIn} in: "${rateRaw}" is not a usable dollar amount${unchanged}`); i++; continue; }
        ratePerLf = n;
      }
      // Widths this increase is hauled at, written EXPLICITLY — never collapsed back to null
      // (174). 173 borrowed the window-colour "null = all, including widths added later"
      // contract, and the direction is what makes that wrong here: taller walls LOSE headroom
      // as buildings get wider, so a living default auto-offers every unrestricted increase on
      // each newly added width — usually the widest, i.e. exactly the case this refuses.
      // Carolyn chose (asked directly): a new width arrives unticked, always.
      // A row that ticks nothing at all falls back to this style's current widths rather than
      // storing '{}', which would read as "offered on nothing" and silently retire the row.
      let widthsFt: number[] | null = allWidths.length ? allWidths : null;
      if (Array.isArray(row?.widthsFt)) {
        const cleaned = (row.widthsFt as unknown[])
          .map((w) => Number(w))
          .filter((w) => Number.isFinite(w) && w > 0);
        const picked = [...new Set(cleaned)].sort((x, y) => x - y);
        if (picked.length) widthsFt = picked;
      }
      // Built on site (183). The flag is free-standing: a builder can mark an increase as
      // on-site-only and charge nothing for it, which is why an absent fee is stored as NULL
      // rather than refused. A fee that is PRESENT but unusable IS refused, the same posture
      // as the rate above — a typo silently becoming $0 is the failure worth preventing.
      const buildOnSite = row?.buildOnSite === true;
      const bosRateRaw = String(row?.bosFeeRate ?? "").trim();
      let bosFeeRate: number | null = null;
      if (buildOnSite && bosRateRaw !== "") {
        const n = Number(bosRateRaw);
        if (!Number.isFinite(n) || n < 0) { skipped.push(`+${deltaIn} in: "${bosRateRaw}" is not a usable build-on-site fee${unchanged}`); i++; continue; }
        bosFeeRate = n;
      }
      // All seven pricing methods since 228 — the same list the DB check constraint enforces.
      const BOS_BASES = ["each", "lineal_ft", "sqft_option", "sqft_building", "perimeter_building", "pct_building_price", "pct_estimate_total"];
      const bosBasisRaw = String(row?.bosFeeBasis ?? "").trim();
      // An unrecognised basis is refused rather than defaulted: defaulting would price the fee
      // by a rule the builder did not choose, and the shapes differ by orders of magnitude on
      // the same number.
      if (buildOnSite && bosBasisRaw !== "" && !BOS_BASES.includes(bosBasisRaw)) {
        skipped.push(`+${deltaIn} in: "${bosBasisRaw}" is not a build-on-site fee basis${unchanged}`); i++; continue;
      }
      const bosFeeBasis = buildOnSite ? (bosBasisRaw || "each") : null;

      const patch = {
        delta_in: deltaIn,
        rate_per_lf: ratePerLf,
        build_on_site: buildOnSite,
        bos_fee_basis: bosFeeBasis,
        bos_fee_rate: buildOnSite ? bosFeeRate : null,
        taxable: row?.taxable !== false,
        active: row?.active !== false,
        internal_only: row?.internalOnly === true,
        sort_order: i,
        widths_ft: widthsFt,
        updated_at: new Date().toISOString(),
      };
      const res = isExisting
        ? await admin.from("style_wall_heights").update(patch).eq("id", rid).eq("client_id", clientId)
        : await admin.from("style_wall_heights").insert({ client_id: clientId, style_id: styleId, ...patch }).select("id").maybeSingle();
      if (res.error) { skipped.push(`+${deltaIn} in: ${res.error.message}`); i++; continue; }
      if (!isExisting && (res as { data?: { id?: string } }).data?.id) keptIds.add(String((res as { data: { id: string } }).data.id));
      saved++; i++;
    }
    const sweep = [...existingIds].filter((id) => !keptIds.has(id));
    let deleted = 0;
    if (sweep.length) {
      const del = await admin.from("style_wall_heights").delete().in("id", sweep).eq("client_id", clientId);
      if (del.error) return dbFail(req, clientId, "remove the wall heights you deleted", del.error);
      deleted = sweep.length;
    }
    return json({ ok: true, saved, deleted, skipped });
  }

  // Cladding offered per style (207). A FIXED four rows per style, one per D3_CLADDING type,
  // so this upserts what it is sent and sweeps nothing: the set is closed, and a cladding the
  // payload does not mention means "not sent", never "remove it".
  //
  // ⛔ THE ROW IS KEPT WHEN THE RATE IS BLANK, deliberately — the wall-heights posture, not the
  // insulation one. Insulation deletes a cleared cell because the cell holds nothing but a
  // rate; a cladding row also holds the customer-facing name, the basis and the tax flag, and
  // deleting it would throw away a label a builder typed while they were still deciding what
  // to charge. get_config's `rate is not null` filter is what withholds it from the customer.
  if (action === "save_cladding") {
    const styleId = String((payload as Record<string, unknown>).styleId ?? "").trim();
    if (!styleId) return json({ error: "styleId required" }, 400);
    if (!Array.isArray(payload.rows)) return json({ error: "rows[] required" }, 400);
    { const e = tooMany(payload.rows, "rows"); if (e) return json({ error: e }, 400); }

    // The style must be this tenant's. clientId comes from the JWT, never the body — this is
    // what stops a crafted styleId writing cladding onto another builder's catalog.
    const stRes = await admin.from("building_styles").select("id").eq("client_id", clientId).eq("id", styleId).maybeSingle();
    if (stRes.error) return dbFail(req, clientId, "read that style", stRes.error);
    if (!stRes.data) return json({ error: "That building style is not in your catalog." }, 400);

    const CLADDING_IDS = new Set(["panel", "lap", "batten", "agpanel"]);
    // The product's shared pricing vocabulary (221). Kept as an explicit set rather than the
    // pricing_method enum: the values match it deliberately, but a value added to that enum for
    // another table must not silently become offerable here with no implementation behind it.
    const BASES = new Set(["each", "lineal_ft", "sqft_option", "sqft_building",
                           "perimeter_building", "pct_building_price", "pct_estimate_total"]);
    let saved = 0; const skipped: string[] = [];
    const seen = new Set<string>();
    let i = 0;
    for (const raw of payload.rows) {
      const row = raw as Record<string, unknown>;
      const cid = String(row?.claddingId ?? "").trim();
      // Refused, not defaulted. A fifth id would reach D3_CLADDING[id] in the browser as
      // undefined and take the 3D wall material down with it, so it must never be stored.
      if (!CLADDING_IDS.has(cid)) { skipped.push(`row ${i}: "${row?.claddingId}" is not a cladding we ship`); i++; continue; }
      if (seen.has(cid)) { skipped.push(`${cid}: listed twice`); i++; continue; }
      seen.add(cid);

      // Refuse, never coerce — the rate posture everywhere in this file. Blank is a real
      // state ("not offered on this style"), and it must reach the column as NULL rather than
      // as 0: zero means INCLUDED AT NO CHARGE, which is what every tenant was seeded with.
      const rateRaw = String(row?.rate ?? "").trim();
      let rate: number | null = null;
      if (rateRaw !== "") {
        const n = Number(rateRaw);
        if (!Number.isFinite(n) || n < 0) { skipped.push(`${cid}: "${rateRaw}" is not a usable dollar amount`); i++; continue; }
        rate = n;
      }
      // An unrecognised basis is refused rather than defaulted: the three shapes differ by
      // orders of magnitude on the same number, so defaulting would price by a rule the
      // builder did not choose.
      const basisRaw = String(row?.basis ?? "").trim();
      if (basisRaw !== "" && !BASES.has(basisRaw)) { skipped.push(`${cid}: "${basisRaw}" is not a pricing basis`); i++; continue; }

      const patch = {
        label_override: String(row?.labelOverride ?? "").trim().slice(0, 60) || null,
        rate,
        basis: basisRaw || "sqft_option",
        taxable: row?.taxable !== false,
        active: row?.active !== false,
        internal_only: row?.internalOnly === true,
        sort_order: i,
        updated_at: new Date().toISOString(),
      };
      const up = await admin.from("style_cladding")
        .upsert({ client_id: clientId, style_id: styleId, cladding_id: cid, ...patch },
                { onConflict: "client_id,style_id,cladding_id" });
      if (up.error) { skipped.push(`${cid}: ${up.error.message}`); i++; continue; }
      saved++; i++;
    }
    return json({ ok: true, saved, skipped });
  }

  // ── Foundation services (237) ─────────────────────────────────────────────────────────
  // The save_cladding shape without the style check: four fixed ids per TENANT, upserted by
  // (client_id, item_id). Blank rate → NULL (not offered) and the row is KEPT, so a builder can
  // park a rate for a season; 0 = included; unknown basis or id is skipped, never defaulted.
  if (action === "save_foundation") {
    if (!Array.isArray(payload.rows)) return json({ error: "rows[] required" }, 400);
    { const e = tooMany(payload.rows, "rows"); if (e) return json({ error: e }, 400); }
    const FOUNDATION_IDS = new Set(["gravel_pad", "fence_removal", "piers", "concrete_slab"]);
    const BASES = new Set(["each", "lineal_ft", "sqft_option", "sqft_building",
                           "perimeter_building", "pct_building_price", "pct_estimate_total"]);
    let saved = 0; const skipped: string[] = [];
    const seen = new Set<string>();
    let i = 0;
    for (const raw of payload.rows) {
      const row = raw as Record<string, unknown>;
      const fid = String(row?.itemId ?? "").trim();
      if (!FOUNDATION_IDS.has(fid)) { skipped.push(`row ${i}: "${row?.itemId}" is not a foundation item we ship`); i++; continue; }
      if (seen.has(fid)) { skipped.push(`${fid}: listed twice`); i++; continue; }
      seen.add(fid);
      const rateRaw = String(row?.rate ?? "").trim();
      let rate: number | null = null;
      if (rateRaw !== "") {
        const n = Number(rateRaw);
        if (!Number.isFinite(n) || n < 0) { skipped.push(`${fid}: "${rateRaw}" is not a usable dollar amount`); i++; continue; }
        rate = n;
      }
      const basisRaw = String(row?.basis ?? "").trim();
      if (basisRaw !== "" && !BASES.has(basisRaw)) { skipped.push(`${fid}: "${basisRaw}" is not a pricing basis`); i++; continue; }
      const patch = {
        label_override: String(row?.labelOverride ?? "").trim().slice(0, 60) || null,
        rate,
        basis: basisRaw || "each",
        taxable: row?.taxable !== false,
        active: row?.active !== false,
        internal_only: row?.internalOnly === true,
        sort_order: i,
        updated_at: new Date().toISOString(),
      };
      const up = await admin.from("foundation_items")
        .upsert({ client_id: clientId, item_id: fid, ...patch }, { onConflict: "client_id,item_id" });
      if (up.error) { skipped.push(`${fid}: ${up.error.message}`); i++; continue; }
      saved++; i++;
    }
    return json({ ok: true, saved, skipped });
  }

  // ── Delivery (233–236) ─────────────────────────────────────────────────────────────────
  // Its own read rather than a sixteenth query in `catalog`: the card also needs the origin
  // addresses on file and whether distance lookups are configured, and neither belongs in the
  // catalog every other Options card loads.
  if (action === "delivery_settings") {
    const [ds, cs, locs] = await Promise.all([
      admin.from("delivery_settings").select("*").eq("client_id", clientId).maybeSingle(),
      admin.from("client_settings").select("business_name, business_address, ss_tax_delivery").eq("client_id", clientId).maybeSingle(),
      admin.from("builder_locations").select("id, name, street, city, state, zip").eq("client_id", clientId).eq("active", true).order("sort_order"),
    ]);
    for (const r of [ds, cs, locs]) if (r.error) return dbFail(req, clientId, "load your delivery settings", r.error);
    return json({
      ok: true,
      settings: ds.data ?? null,
      businessName: cs.data?.business_name ?? null,
      businessAddress: cs.data?.business_address ?? null,
      ssTaxDelivery: cs.data?.ss_tax_delivery === true,
      locations: locs.data ?? [],
      distanceConfigured: deliveryDistanceConfigured(),
    });
  }

  if (action === "save_delivery_settings") {
    const p = payload as Record<string, unknown>;
    // One validator for the rule shape, shared with every reader (deliveryFee.ts), so a rule
    // the card could save is a rule the estimate can price. Refuses with the field named.
    const norm = normalizeRules(p);
    if (norm.error || !norm.rules) return json({ error: norm.error || "Those delivery rules can't be saved." }, 400);
    const rules = norm.rules;
    const originMode = String(p.originMode ?? "business").trim();
    if (!["business", "rep", "nearest"].includes(originMode)) return json({ error: "Choose where delivery is measured from." }, 400);
    const automate = p.automate === true;
    if (automate) {
      // Automatic delivery must be able to price SOMETHING before it is switched on — the
      // ss_tax_rate posture (158): refuse rather than let every quote silently go out without
      // a line the builder believes is being added.
      const probe = feeFor(rules, rules.ruleType === "flat" ? null : 1, null);
      if (probe.reason === "rule_incomplete") return json({ error: "Fill in the fee before turning automatic delivery on." }, 400);
      if (rules.ruleType !== "flat" && !deliveryDistanceConfigured()) {
        return json({ error: "Distance lookups aren't configured on this server yet, so a mileage rule can't run automatically. A flat fee can, or ask CSM Synergy to add the Google key." }, 400);
      }
      if (rules.ruleType !== "flat") {
        const cs = await admin.from("client_settings").select("business_address").eq("client_id", clientId).maybeSingle();
        const ba = (cs.data?.business_address ?? null) as Record<string, unknown> | null;
        const bizOk = !!(ba && ba.city && ba.state && ba.postalCode);
        const locs = await admin.from("builder_locations").select("id").eq("client_id", clientId).eq("active", true).not("city", "is", null).not("zip", "is", null).limit(1);
        const anyLot = (locs.data ?? []).length > 0;
        if (originMode === "business" && !bizOk) return json({ error: "Add your business address under Settings → Company before measuring delivery from it." }, 400);
        if (originMode !== "business" && !bizOk && !anyLot) return json({ error: "Add a business address or a location with a city, state and zip before measuring delivery from it." }, 400);
      }
    }
    const up = await admin.from("delivery_settings").upsert({
      client_id: clientId,
      automate,
      origin_mode: originMode,
      rule_type: rules.ruleType,
      flat_fee: rules.flatFee,
      base_fee: rules.baseFee,
      per_mile: rules.perMile,
      free_miles: rules.freeMiles,
      per_mile_counts: rules.perMileCounts,
      bands: rules.bands,
      updated_at: new Date().toISOString(),
    }, { onConflict: "client_id" });
    if (up.error) return dbFail(req, clientId, "save your delivery settings", up.error);
    // Taxable rides along, presence-guarded. It is client_settings.ss_tax_delivery (158) — the
    // same switch the Company card shows — written here too because Delivery now lives under
    // Options and Carolyn wants every Services line to carry Taxable like everything else.
    // UPSERT with a minimal payload, the save_insulation lesson: a tenant with no settings row
    // must not be told "saved" by a zero-row update.
    if (Object.prototype.hasOwnProperty.call(p, "ssTaxDelivery")) {
      const tx = await admin.from("client_settings")
        .upsert({ client_id: clientId, ss_tax_delivery: p.ssTaxDelivery === true, updated_at: new Date().toISOString() }, { onConflict: "client_id" });
      if (tx.error) return dbFail(req, clientId, "save the delivery tax switch", tx.error);
    }
    await auditStrict("portal_delivery_settings", 1, `automate=${automate} origin=${originMode} rule=${rules.ruleType}`);
    return json({ ok: true });
  }

  // "Test an address" on the Delivery card: the same quoteDelivery the customer designer and
  // submit-estimate use, so what the builder sees here is what the customer will be charged.
  if (action === "delivery_test_address") {
    const a = ((payload as Record<string, unknown>).address ?? {}) as Record<string, unknown>;
    const address = {
      street: String(a.street ?? "").trim().slice(0, 200),
      city: String(a.city ?? "").trim().slice(0, 100),
      state: String(a.state ?? "").trim().slice(0, 60),
      zip: String(a.zip ?? "").trim().slice(0, 12),
    };
    if (!address.city || !address.state || !address.zip) return json({ error: "Enter at least a city, state and zip to test." }, 400);
    const quote = await quoteDelivery(admin, { clientId, address, repUserId: userId ?? null });
    return json({ ok: true, quote });
  }

  // Insulation rates (177). A fixed 2x3 matrix rather than a free row list, so this is an
  // UPSERT per supplied cell plus a delete for any cell the builder cleared — there is no
  // sweep, because the shape is fixed and a missing cell means "not sent", not "removed".
  if (action === "save_electrical_items") {
    const rows = Array.isArray((payload as Record<string, unknown>).rows)
      ? (payload as Record<string, unknown>).rows as Record<string, unknown>[] : [];
    if (rows.length > MAX_BULK_ROWS) return json({ error: `That's more than ${MAX_BULK_ROWS} items in one save.` }, 400);
    const MOUNTS = new Set(["wall", "ceiling"]);
    // A price is EITHER a number >= 0 or genuinely absent. "" means "not offered in this mode",
    // which is a real state and must reach the column as NULL rather than as 0 — zero is a
    // FREE item, and the two must never be confused.
    const priceOf = (v: unknown): number | null | undefined => {
      const t = String(v ?? "").trim();
      if (t === "") return null;
      const n = Number(t);
      return Number.isFinite(n) && n >= 0 ? n : undefined;   // undefined = reject
    };
    const keep: string[] = [];
    let saved = 0;
    for (const r of rows) {
      const name = String(r?.name ?? "").trim().slice(0, 60);
      if (!name) continue;
      const withPkg = priceOf(r?.priceWithPackage);
      const alone = priceOf(r?.priceStandalone);
      if (withPkg === undefined || alone === undefined) {
        return json({ error: `"${name}" has a price that isn't a number. Leave a price blank to mean you don't offer it that way.` }, 400);
      }
      const mount = MOUNTS.has(String(r?.mount ?? "")) ? String(r?.mount) : "wall";
      const row: Record<string, unknown> = {
        client_id: clientId,
        name,
        icon: String(r?.icon ?? "\u26a1").slice(0, 8) || "\u26a1",
        mount,
        height_off_floor_in: String(r?.heightOffFloorIn ?? "").trim() === "" ? null : Number(r?.heightOffFloorIn),
        price_with_package: withPkg,
        price_standalone: alone,
        taxable: r?.taxable !== false,
        active: r?.active !== false,
        internal_only: r?.internalOnly === true,
        sort_order: Number(r?.sortOrder) || 0,
        updated_at: new Date().toISOString(),
      };
      // ── RENAME IS AN UPDATE, NOT AN UPSERT ────────────────────────────────────────────
      // The row carries BOTH the primary key and a conflict target of (client_id, name), and
      // those disagree the moment a builder renames an item: Postgres routes the statement by
      // the named conflict target, finds no row with the NEW name, and inserts — straight into
      // a primary-key violation on the id it was handed. Renaming an electrical item 500'd
      // every time, with the authored "Couldn't save your electrical items" hiding a
      // duplicate-key error underneath.
      //
      // Branching on the id fixes it and says what each path means: an id is "this row,
      // whatever it is called now", no id is "a new item, keyed by its name". `.eq("client_id",
      // clientId)` on the update is load-bearing and not decoration — the id arrives in the
      // request body, and without the tenant scope a chosen id would reach another tenant's row.
      const rawId = String(r?.id ?? "").trim();
      // A malformed id is treated as "new" rather than passed to Postgres, which would answer
      // 22P02 and turn a typo into another 500.
      const id = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(rawId) ? rawId : "";
      // A name collision inside one payload (two rows renamed to the same thing, or a rename
      // onto a name that already exists) is the builder's mistake, not a fault: name it.
      const nameClash = (err: { code?: string } | null) =>
        String(err?.code ?? "") === "23505"
          ? json({ error: `You already have an electrical item called "${name}". Give one of them a different name.` }, 409)
          : null;
      let savedId: string | null = null;
      if (id) {
        const upd = await admin.from("electrical_items").update(row)
          .eq("id", id).eq("client_id", clientId).select("id").maybeSingle();
        if (upd.error) return nameClash(upd.error) ?? dbFail(req, clientId, "save your electrical items", upd.error);
        savedId = upd.data?.id ? String(upd.data.id) : null;
      }
      // No id, or an id that no longer matches a row of this tenant's (deleted from another
      // session mid-edit): fall through to the name-keyed upsert so the save still lands.
      if (!savedId) {
        const up = await admin.from("electrical_items").upsert(row, { onConflict: "client_id,name" }).select("id").single();
        if (up.error) return nameClash(up.error) ?? dbFail(req, clientId, "save your electrical items", up.error);
        savedId = up.data?.id ? String(up.data.id) : null;
      }
      // Every kept id, INCLUDING a renamed row's, or the sweep below deletes what we just saved.
      if (savedId) keep.push(savedId);
      saved++;
    }
    // Anything the editor did not send back was removed in the UI. Delete rather than
    // deactivate: this is the builder's own list and they expect a removed row to be gone.
    const del = await admin.from("electrical_items").delete().eq("client_id", clientId)
      .not("id", "in", `(${keep.length ? keep.map((k) => `"${k}"`).join(",") : '"00000000-0000-0000-0000-000000000000"'})`);
    if (del.error) return dbFail(req, clientId, "tidy up your electrical items", del.error);
    return json({ ok: true, saved });
  }

  if (action === "save_electrical") {
    // One row per tenant, upserted whole. Unlike the rate grids there is nothing here to
    // partially clear: every field has a value, and the price is the one nullable.
    const numOr = (v: unknown, dflt: number, min: number) => {
      const n = Number(v);
      return Number.isFinite(n) && n >= min ? n : dflt;
    };
    // "" and null both mean "the package lays out none of these" — the picker's own empty
    // option. Anything that is not a uuid is treated the same way, so a malformed id can
    // never reach the FK as a Postgres error the builder cannot read.
    const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    const elecItemRef = (v: unknown): string | null => {
      const t = String(v ?? "").trim();
      return UUID_RE.test(t) ? t : null;
    };
    const rawPrice = String((payload as Record<string, unknown>).packagePrice ?? "").trim();
    const price = rawPrice === "" ? null : Number(rawPrice);
    if (price != null && (!Number.isFinite(price) || price < 0)) {
      return json({ error: "The package price must be a number, or blank if you're not offering it yet." }, 400);
    }
    const row = {
      client_id: clientId,
      enabled: (payload as Record<string, unknown>).enabled === true,
      package_price: price,
      package_label: String((payload as Record<string, unknown>).packageLabel ?? "Electrical Package").slice(0, 60) || "Electrical Package",
      taxable: (payload as Record<string, unknown>).taxable !== false,
      internal_only: (payload as Record<string, unknown>).internalOnly === true,
      // The spacings must stay > 0: they are divisors in the auto-layout, and a zero would
      // produce an infinite device count in the customer's browser. The table CHECKs this too;
      // this keeps the refusal a readable sentence rather than a Postgres constraint error.
      outlet_spacing_ft: Math.max(0.5, numOr((payload as Record<string, unknown>).outletSpacingFt, 6, 0.5)),
      light_spacing_ft: Math.max(0.5, numOr((payload as Record<string, unknown>).lightSpacingFt, 10, 0.5)),
      outlet_height_in: numOr((payload as Record<string, unknown>).outletHeightIn, 24, 0),
      outlet_above_bench_in: numOr((payload as Record<string, unknown>).outletAboveBenchIn, 42, 0),
      switch_height_in: numOr((payload as Record<string, unknown>).switchHeightIn, 48, 0),
      panel_height_in: numOr((payload as Record<string, unknown>).panelHeightIn, 60, 0),
      include_panel: (payload as Record<string, unknown>).includePanel !== false,
      // The three device pointers (206) — WHICH electrical_item the package lays out for each
      // role. They were missing here until 2026-09-07, which made the pickers inert: the card
      // could not read them back and this action never wrote them, so the only pointers in
      // existence were the ones the migration set by hand. Ownership is checked below rather
      // than left to the FK: the constraint proves the item EXISTS, not that it is this
      // tenant's, and these ids arrive from the browser.
      outlet_item_id: elecItemRef((payload as Record<string, unknown>).outletItemId),
      switch_item_id: elecItemRef((payload as Record<string, unknown>).switchItemId),
      light_item_id: elecItemRef((payload as Record<string, unknown>).lightItemId),
      updated_at: new Date().toISOString(),
    };
    // Every non-null pointer must name one of THIS tenant's items. Refused loudly rather than
    // nulled quietly: silently dropping a pointer looks like a save that worked and leaves the
    // package laying out nothing.
    const refs = [row.outlet_item_id, row.switch_item_id, row.light_item_id].filter((v): v is string => !!v);
    if (refs.length) {
      const own = await admin.from("electrical_items").select("id").eq("client_id", clientId).in("id", refs);
      if (own.error) return dbFail(req, clientId, "save your electrical settings", own.error);
      const ok = new Set((own.data ?? []).map((r: { id: string }) => r.id));
      if (refs.some((id) => !ok.has(id))) {
        return json({ error: "One of your standards points at an electrical item that isn't on your list. Save the item first, then pick it." }, 400);
      }
    }
    const up = await admin.from("electrical_settings").upsert(row, { onConflict: "client_id" });
    if (up.error) return dbFail(req, clientId, "save your electrical settings", up.error);
    return json({ ok: true });
  }

  if (action === "save_insulation") {
    if (!Array.isArray(payload.rows)) return json({ error: "rows[] required" }, 400);
    { const e = tooMany(payload.rows, "rows"); if (e) return json({ error: e }, 400); }
    const TYPES = new Set(["batt", "spray_foam"]);
    const AREAS = new Set(["floor", "walls", "roof"]);

    // The master switch, presence-guarded so a save that does not mention it cannot flip it.
    // It lives on client_settings (the ramp_enabled precedent) rather than on the rate rows,
    // because turning insulation off must not touch the rates a builder spent time entering.
    //
    // UPSERT, not update: a tenant who has never written a client_settings row matched zero
    // rows here, and PostgREST calls a zero-row update a success — so the switch reported
    // saved, the card redrew from the same absent row, and insulation could never be turned
    // on at all. This is the shape save_ramp_settings already uses for the same column family.
    // The payload stays MINIMAL on purpose: client_id + the one column + updated_at, because an
    // upsert is a full-row write on the create path and any column named here with a default
    // would overwrite whatever else the row holds.
    if (Object.prototype.hasOwnProperty.call(payload, "enabled")) {
      const up = await admin.from("client_settings")
        .upsert({
          client_id: clientId,
          insulation_enabled: payload.enabled === true,
          updated_at: new Date().toISOString(),
        }, { onConflict: "client_id" });
      if (up.error) return dbFail(req, clientId, "save your insulation switch", up.error);
    }

    let saved = 0, cleared = 0; const skipped: string[] = [];
    for (const raw of payload.rows) {
      const row = raw as Record<string, unknown>;
      const insType = String(row?.type ?? "").trim();
      const area = String(row?.area ?? "").trim();
      if (!TYPES.has(insType) || !AREAS.has(area)) { skipped.push(`${insType}/${area}: not a known type or area`); continue; }

      // Refuse, never coerce — the posture everywhere in this file. A blank rate is the
      // deliberate "not offered": the row is REMOVED so get_config stops emitting it, which is
      // what makes the customer's toggle disappear.
      const rateRaw = String(row?.ratePerSqft ?? "").trim();
      if (rateRaw === "") {
        const del = await admin.from("insulation_offerings").delete()
          .eq("client_id", clientId).eq("ins_type", insType).eq("area", area);
        if (del.error) { skipped.push(`${insType}/${area}: ${del.error.message}`); continue; }
        cleared++; continue;
      }
      const rate = Number(rateRaw);
      if (!Number.isFinite(rate) || rate < 0) { skipped.push(`${insType}/${area}: "${rateRaw}" is not a usable dollar amount`); continue; }

      const res = await admin.from("insulation_offerings").upsert({
        client_id: clientId, ins_type: insType, area,
        rate_per_sqft: rate,
        taxable: row?.taxable !== false,
        // `active` is the per-TYPE "do we offer this at all" switch — the portal writes the
        // same value to all three areas of a type, which is how "batt or spray foam or both"
        // is expressed without a second table.
        active: row?.active !== false,
        internal_only: row?.internalOnly === true,
        updated_at: new Date().toISOString(),
      }, { onConflict: "client_id,ins_type,area" });
      if (res.error) { skipped.push(`${insType}/${area}: ${res.error.message}`); continue; }
      saved++;
    }
    return json({ ok: true, saved, cleared, skipped });
  }

  if (action === "save_colors") {
    if (!Array.isArray(payload.colors)) return json({ error: "colors[] required" }, 400);
    { const e = tooMany(payload.colors, "colors"); if (e) return json({ error: e }, 400); }
    const ALLOWED_METHODS = new Set(["each", "lineal_ft", "sqft_option", "sqft_building", "perimeter_building", "pct_building_price", "pct_estimate_total"]);
    const exRes = await admin.from("colors").select("id").eq("client_id", clientId);
    if (exRes.error) return dbFail(req, clientId, "read your current colors", exRes.error);
    const existingIds = new Set((exRes.data ?? []).map((r: any) => String(r.id)));
    const keptIds = new Set<string>();
    let saved = 0; const skipped: string[] = [];
    let i = 0;
    for (const row of payload.colors) {
      // An existing row's id counts as KEPT the moment it appears in the payload — BEFORE any
      // validation — so the delete sweep below can never turn a skipped row into a deleted
      // one. keptIds used to be populated only on the update branch, so a colour whose label
      // was blanked mid-retype was reported "skipped" but silently swept (audit 2026-08-20).
      const rid = String(row?.id ?? "").trim();
      const isExisting = rid !== "" && existingIds.has(rid);
      if (isExisting) keptIds.add(rid);
      const unchanged = isExisting ? " — existing colour left unchanged" : "";
      const label = String(row?.label ?? "").trim();
      if (!label) { skipped.push(`row ${i}: blank label${unchanged}`); i++; continue; }
      const method = String(row?.pricingMethod ?? "each").trim() || "each";
      if (!ALLOWED_METHODS.has(method)) { skipped.push(`${label}: invalid method "${method}"${unchanged}`); i++; continue; }
      const rate = Number(row?.rate);
      const rec: Record<string, unknown> = {
        client_id: clientId,
        label,
        siding: row?.siding !== false,       // default true
        trim: row?.trim !== false,           // default true
        allow_custom: row?.allowCustom === true,
        is_default: row?.isDefault === true,
        active: row?.active !== false,       // default true
        rate: Number.isFinite(rate) && rate >= 0 ? rate : 0,
        pricing_method: method,
        // Optional swatch color as a hex string (#RGB / #RRGGBB). Anything else → null.
        hex: (typeof row?.hex === "string" && /^#[0-9a-fA-F]{3,8}$/.test(row.hex.trim())) ? row.hex.trim() : null,
        sort_order: Number.isFinite(Number(row?.sortOrder)) ? Number(row.sortOrder) : i,
        updated_at: new Date().toISOString(),
      };
      // Roof categories (shingle/metal). Only written when the caller sends them, so an older
      // client that doesn't know about these keys can't clear a color's roof categorization.
      if (Object.prototype.hasOwnProperty.call(row, "shingle")) rec.shingle = row.shingle === true;
      if (Object.prototype.hasOwnProperty.call(row, "metal")) rec.metal = row.metal === true;
      // Door category (116) rides the same presence-guard: `door` = usable on doors,
      // `doorRate` = FLAT $ per door painted this color (distinct from the paint rate).
      if (Object.prototype.hasOwnProperty.call(row, "door")) rec.door = row.door === true;
      // Sales tax (migration 148) — same presence guard, same reason: an older client that
      // does not know this key must not silently make an exempted colour taxable again.
      if (Object.prototype.hasOwnProperty.call(row, "taxable")) rec.taxable = row.taxable !== false;
      // Serial-number code (163). Carolyn, 2026-08-28 @58:32: "I want them to be able to put
      // their codes in for the colors ... we probably need to put the color code in here so
      // that they can change it, because they might have other color codes that they want."
      // Same presence guard as every optional column above: an older client that does not
      // send this key must not blank a code the builder has already set.
      //
      // Upper-cased and capped at 4 because it is a fixed-width segment of a serial someone
      // reads off a tag in front of a customer (0826LBA1016REBLDWS5000). Blank stores NULL
      // rather than '', so the partial unique indexes in 163 treat "not set yet" as one
      // builder's many un-coded rows instead of a pile of duplicates.
      if (Object.prototype.hasOwnProperty.call(row, "code")) {
        rec.code = String(row.code ?? "").trim().toUpperCase().slice(0, 4) || null;
      }
      if (Object.prototype.hasOwnProperty.call(row, "doorRate")) {
        const dr = Number(row.doorRate);
        rec.door_rate = Number.isFinite(dr) && dr >= 0 ? dr : 0;
      }
      if (Object.prototype.hasOwnProperty.call(row, "imageUrl")) {
        rec.image_url = String(row.imageUrl ?? "").trim() || null;
      }
      const res = isExisting
        ? await admin.from("colors").update(rec).eq("client_id", clientId).eq("id", rid)
        : await admin.from("colors").insert(rec);
      if (res.error) {
        // Section derived from the row's OWN flags, using the same predicate as 161's
        // indexes -- so the sentence names the palette the collision actually happened in.
        const sect = rec.shingle ? "shingle" : rec.metal ? "metal" : "paint";
        skipped.push(`${label}: ${colorSaveReason(res.error, label, sect)}`);
        i++; continue;
      }
      saved++; i++;
    }
    const toDelete = [...existingIds].filter((id) => !keptIds.has(id));
    let deleted = 0;
    if (toDelete.length) {
      const del = await admin.from("colors").delete().eq("client_id", clientId).in("id", toDelete);
      if (del.error) return dbFail(req, clientId, "remove the colors you deleted", del.error);
      deleted = toDelete.length;
    }
    return json({ ok: true, saved, deleted, skipped });
  }

  // Full-replace this tenant's WINDOW color list (Options tab → Windows section, 116).
  // Same shape and invariants as save_colors: complete desired list, ids update, no-id
  // inserts, absentees deleted; an existing row counts as KEPT the moment its id appears —
  // before validation — so a skipped row can never be swept (audit 2026-08-20). rate is a
  // FLAT $ per window (no pricing_method engine here). clientId is JWT-resolved.
  if (action === "save_window_colors") {
    if (!Array.isArray(payload.colors)) return json({ error: "colors[] required" }, 400);
    { const e = tooMany(payload.colors, "window colors"); if (e) return json({ error: e }, 400); }
    const exRes = await admin.from("window_colors").select("id").eq("client_id", clientId);
    if (exRes.error) return dbFail(req, clientId, "read your current window colors", exRes.error);
    const existingIds = new Set((exRes.data ?? []).map((r: any) => String(r.id)));
    const keptIds = new Set<string>();
    let saved = 0; const skipped: string[] = [];
    let i = 0;
    for (const row of payload.colors) {
      const rid = String(row?.id ?? "").trim();
      const isExisting = rid !== "" && existingIds.has(rid);
      if (isExisting) keptIds.add(rid);
      const unchanged = isExisting ? " — existing color left unchanged" : "";
      const label = String(row?.label ?? "").trim();
      if (!label) { skipped.push(`row ${i}: blank label${unchanged}`); i++; continue; }
      const rate = Number(row?.rate);
      const rec: Record<string, unknown> = {
        client_id: clientId,
        label,
        hex: (typeof row?.hex === "string" && /^#[0-9a-fA-F]{3,8}$/.test(row.hex.trim())) ? row.hex.trim() : null,
        rate: Number.isFinite(rate) && rate >= 0 ? rate : 0,
        is_default: row?.isDefault === true,
        active: row?.active !== false,       // default true
        sort_order: Number.isFinite(Number(row?.sortOrder)) ? Number(row.sortOrder) : i,
        updated_at: new Date().toISOString(),
      };
      const res = isExisting
        ? await admin.from("window_colors").update(rec).eq("client_id", clientId).eq("id", rid)
        : await admin.from("window_colors").insert(rec);
      if (res.error) { skipped.push(`${label}: ${res.error.message}`); i++; continue; }
      saved++; i++;
    }
    const toDelete = [...existingIds].filter((id) => !keptIds.has(id));
    let deleted = 0;
    if (toDelete.length) {
      const del = await admin.from("window_colors").delete().eq("client_id", clientId).in("id", toDelete);
      if (del.error) return dbFail(req, clientId, "remove the window colors you deleted", del.error);
      deleted = toDelete.length;
    }
    return json({ ok: true, saved, deleted, skipped });
  }

  // ═══ Per-line fixture editing (2026-08-03) ════════════════════════════════════
  // The catalog editors save one line at a time. One validation source shared by
  // save_fixture and import_fixtures.
  //
  // (The full-replace save_doors/save_ramps/save_windows this superseded were deleted
  // 2026-08-07. They had no caller anywhere in the repo and were kept only for a cached
  // portal.html window that closed at the 2026-08-03 promotion — but each one DELETED every
  // fixture_items row of its category absent from the payload, so three unreachable
  // bulk-delete endpoints were sitting on a live table. They had also already drifted from
  // the rules below: the legacy copies lacked the op-exclusivity normalization.)
  // Ramps/windows force swing/op false/null; ramp height_in holds LENGTH (error wording).
  // price NULL is legal (NULL-price contract: not-yet-priced = not offered) — never coerce
  // blank to 0. Op exclusivity (Double / Slide up are standalone) is normalized HERE because
  // spreadsheet imports bypass the UI's setOp logic.
  //
  // Field-presence contract (audit 2026-08-20): name/size/price are required; every OTHER
  // field is written only when the caller actually sent it. A trimmed sheet (flag columns
  // deleted in Excel to bulk-edit prices) used to reset archived/internal-only/active/swing
  // on every ID-matched row — silently un-archiving retired doors into the customer
  // designer. The UI's toPayload and a full export round-trip send every field, so those
  // saves behave exactly as before; inserts get the old defaults via fixtureInsertDefaults.
  // 'vent' added 2026-09-05 (Carolyn 09-04 @25:19). It needs NO validator branch: every
  // door-only group (swing/operation, colour mode, trim colour, door_style) and every
  // window-only group (window colours, sill) is already forced off by the `!isDoor` /
  // `category !== "window"` invariants below, so a vent validates down to name, width,
  // height and price — which is exactly what a vent is.
  const FIXTURE_CATEGORIES = new Set(["door", "window", "ramp", "vent"]);
  const validateFixtureRow = (row: any, category: string, i: number): { rec?: Record<string, unknown>; err?: string } => {
    // JSON.stringify drops undefined-valued keys client-side, so "absent key" is the wire
    // form of "leave this field alone"; the explicit !== undefined guards a hand-built call.
    const has = (k: string) => Object.prototype.hasOwnProperty.call(row ?? {}, k) && row?.[k] !== undefined;
    const numOrNull = (v: unknown) => { const s = String(v ?? "").replace(/[$,\s]/g, ""); if (s === "") return null; const n = Number(s); return Number.isFinite(n) ? n : NaN; };
    const name = String(row?.name ?? "").trim();
    if (!name) return { err: `row ${i + 1}: blank name` };
    const w = numOrNull(row?.widthIn), h = numOrNull(row?.heightIn);
    if (w === null || Number.isNaN(w) || (w as number) <= 0) return { err: `${name}: invalid width` };
    if (h === null || Number.isNaN(h) || (h as number) <= 0) return { err: `${name}: invalid ${category === "ramp" ? "length" : "height"}` };
    const price = numOrNull(row?.price);
    if (Number.isNaN(price)) return { err: `${name}: invalid price` };
    const rec: Record<string, unknown> = {
      client_id: clientId, category, name,
      width_in: w, height_in: h, price,
      updated_at: new Date().toISOString(),
    };
    if (has("planLabel")) rec.plan_label = (String(row?.planLabel ?? "").trim().slice(0, 12)) || null;
    if (has("showImageOnEstimate")) rec.show_image_on_estimate = row?.showImageOnEstimate !== false;
    if (has("active")) rec.active = row?.active !== false;
    if (has("archived")) rec.archived = row?.archived === true;
    if (has("internalOnly")) rec.internal_only = row?.internalOnly === true;
    // Sales tax (migration 148). Presence-gated like its neighbours: a trimmed import sheet
    // with the column deleted must not silently make every fixture taxable again — that is
    // the same class of bug the 2026-08-20 audit fixed for archived/internal-only, and here
    // it would put tax on a bill the builder deliberately exempted.
    if (has("taxable")) rec.taxable = row?.taxable !== false;
    const isDoor = category === "door";
    // Swing/op travel as a GROUP: the exclusivity normalization is only sound when the whole
    // group is known, so one present swing/op key means the absent ones read "no" (the old
    // behavior), while a row carrying NONE of them leaves the stored operation untouched.
    // Non-doors still force the group false/null unconditionally (invariant above).
    const swingOpProvided = ["swingIn", "swingOut", "swingDefault", "opRight", "opLeft", "opDouble", "opSlideUp", "opDefault"].some(has);
    if (!isDoor || swingOpProvided) {
      const swingIn = isDoor && row?.swingIn === true, swingOut = isDoor && row?.swingOut === true;
      let opRight = isDoor && row?.opRight === true, opLeft = isDoor && row?.opLeft === true;
      const opDouble = isDoor && row?.opDouble === true;
      let opSlideUp = isDoor && row?.opSlideUp === true;
      if (opDouble && opSlideUp) opSlideUp = false;
      if (opDouble || opSlideUp) { opRight = false; opLeft = false; }
      const swingDefault = (swingIn && swingOut && (row?.swingDefault === "in" || row?.swingDefault === "out")) ? row.swingDefault : null;
      const opDefault = (opRight && opLeft && (row?.opDefault === "right" || row?.opDefault === "left")) ? row.opDefault : null;
      rec.swing_in = swingIn; rec.swing_out = swingOut; rec.swing_default = swingDefault;
      rec.op_right = opRight; rec.op_left = opLeft; rec.op_double = opDouble; rec.op_slideup = opSlideUp; rec.op_default = opDefault;
    }
    if (has("imageUrl")) rec.image_url = String(row.imageUrl ?? "").trim() || null;
    // Door color behavior (116). Doors only, presence-guarded like every other optional
    // field; non-doors force the group unconditionally (same invariant as swing/op).
    // fixed_color_id is validated against the tenant's door-flagged palette by the CALLER
    // (save_fixture 400s, import_fixtures nulls + notes) — this validator has no DB access.
    if (!isDoor) {
      rec.color_mode = "fixed"; rec.has_trim_color = false; rec.fixed_color_id = null;
    } else {
      if (has("colorMode")) {
        const cm = String(row?.colorMode ?? "").trim();
        rec.color_mode = (cm === "paint" || cm === "match") ? cm : "fixed";
      }
      if (has("hasTrimColor")) rec.has_trim_color = row?.hasTrimColor === true;
      if (has("fixedColorId")) rec.fixed_color_id = String(row?.fixedColorId ?? "").trim() || null;
    }
    // Window color availability (119): windows only, presence-guarded. null = ALL window
    // colors (the living default), array = exactly those (empty = none). Non-uuid strings
    // are dropped here so a malformed id can't fail the whole row at the uuid[] cast; the
    // CALLERS additionally filter to ids that exist in this tenant's window_colors.
    const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    if (category !== "window") {
      rec.window_color_ids = null;
    } else if (has("windowColorIds")) {
      if (row.windowColorIds === null) rec.window_color_ids = null;
      else if (Array.isArray(row.windowColorIds)) {
        rec.window_color_ids = row.windowColorIds.map((x: unknown) => String(x ?? "").trim()).filter((s: string) => UUID_RE.test(s));
      }
    }
    // Height off the FLOOR (139): windows AND DOORS, presence-guarded, same shape as above.
    // NULL sill_in means "use the designer's default" and is deliberately NOT the same as 0 —
    // 0 is a real answer, an opening that starts at the floor. sill_mode 'variable' lets the
    // customer slide it up and down the wall (Carolyn's transom); 'fixed' pins it.
    // The 12 ft ceiling is a sanity bound, not a product rule: the designer clamps against the
    // actual wall height at build time, which is the only place that knows it.
    //
    // ⚠️ DOORS JOINED ON 2026-09-04, and the rule that stood here is written out rather than
    // deleted because it was right for as long as 139 was the only feature reading these
    // columns. It was: `if (category !== "window") { rec.sill_in = null; rec.sill_mode =
    // "fixed"; }` — a sill was a window's business, and every other category had its pair
    // blanked on save.
    //
    // Carolyn's LOFT DOOR is a category='door' fixture that hangs high on a gable end
    // (2026-09-04 @24:43: "that's a door ... it's called a loft door ... A lot of them have
    // that"; @27:16, on where it belongs: "that loft door goes with the doors"). Its height off
    // the floor IS what makes it a loft door, so the old line would have stored every one of
    // them at zero — a door every builder places at floor level, with nothing anywhere saying
    // why. Reusing 139's own columns rather than adding a door_sill_in beside them: the fact is
    // identical ("how far off the interior floor does this opening start") and so is the bound;
    // a second column would be a second answer to one question.
    //
    // ⚠️ A DOOR IS ALWAYS 'fixed'. 'variable' lets the shopper slide the opening up and down
    // the wall, and a loft door's height is set by where the builder's loft floor is — not
    // something a customer picks. The designer enforces the same thing in exactly one place
    // (its 3D vertical drag tests `type === "window"`), so pinning it here keeps the two
    // agreeing without a third rule to remember, and the catalog UI accordingly offers a door
    // the height field and NO placement select. Forced rather than presence-guarded, so a
    // hand-built call or an older sheet cannot leave 'variable' on a door.
    if (category !== "window" && !isDoor) {
      rec.sill_in = null; rec.sill_mode = "fixed";
    } else {
      if (has("sillIn")) {
        const s = numOrNull(row?.sillIn);
        if (Number.isNaN(s)) return { err: `${name}: invalid height off floor` };
        if (s !== null && ((s as number) < 0 || (s as number) > 144)) return { err: `${name}: height off floor must be between 0 and 12 ft` };
        rec.sill_in = s;
      }
      if (isDoor) rec.sill_mode = "fixed";
      else if (has("sillMode")) rec.sill_mode = row?.sillMode === "variable" ? "variable" : "fixed";
    }
    // How the door is DRAWN in 3D (186): doors only, presence-guarded, whitelisted.
    // 'auto' is today's behaviour (the fixture's photo if it has one, else the generic
    // raised-panel slab) and is what anything unrecognised falls back to, so a typo or a
    // value from a newer portal can only ever mean "render it the way you always did".
    if (!isDoor) {
      rec.door_style = "auto";
    } else if (has("doorStyle")) {
      // Widened by migration 187 from the single 'plank' to four built-in looks. The
      // fallback is the whole point and must survive any future edit: anything unrecognised
      // becomes 'auto', so a typo, an OLDER portal, or a value written by a NEWER portal than
      // this deploy can only ever mean "draw it the way you always did" — never a blank door
      // on a customer's building. Keep this list in step with 187's CHECK constraint and with
      // D3_DOOR_STYLES in portal/03-catalog.jsx.
      rec.door_style = ["plank", "zbrace", "xbrace", "rollup"].includes(String(row?.doorStyle ?? "").trim()) ? String(row?.doorStyle ?? "").trim() : "auto";
    }
    return { rec };
  };
  // Inserts still need concrete values for whatever the presence contract left out — the
  // old unconditional defaults, applied only where no key arrived so sent values win.
  const fixtureInsertDefaults = (rec: Record<string, unknown>) => {
    if (!("plan_label" in rec)) rec.plan_label = null;
    if (!("show_image_on_estimate" in rec)) rec.show_image_on_estimate = true;
    if (!("active" in rec)) rec.active = true;
    if (!("archived" in rec)) rec.archived = false;
    if (!("internal_only" in rec)) rec.internal_only = false;
    if (!("taxable" in rec)) rec.taxable = true;
    if (!("swing_in" in rec)) {
      rec.swing_in = false; rec.swing_out = false; rec.swing_default = null;
      rec.op_right = false; rec.op_left = false; rec.op_double = false; rec.op_slideup = false; rec.op_default = null;
    }
    if (!("color_mode" in rec)) { rec.color_mode = "fixed"; rec.has_trim_color = false; rec.fixed_color_id = null; }
    if (!("window_color_ids" in rec)) rec.window_color_ids = null;
    if (!("sill_in" in rec)) rec.sill_in = null;
    if (!("sill_mode" in rec)) rec.sill_mode = "fixed";
    if (!("door_style" in rec)) rec.door_style = "auto";
    return rec;
  };

  // Keep only window-color ids that exist in THIS tenant's list (foreign/stale ids buy
  // nothing in the designer anyway, but a clean row beats a haunted one). null passes
  // through — it means "all colors", not a list to check.
  const filterWindowColorIds = async (rec: Record<string, unknown>): Promise<void> => {
    const ids = rec.window_color_ids;
    if (!Array.isArray(ids) || ids.length === 0) return;
    const { data } = await admin.from("window_colors").select("id").eq("client_id", clientId).in("id", ids);
    const ok = new Set((data ?? []).map((r: any) => String(r.id)));
    rec.window_color_ids = ids.filter((x) => ok.has(String(x)));
  };

  // The FK on fixture_items.fixed_color_id accepts ANY colors row — including another
  // tenant's — so ownership + door-usability are checked here. Returns null when the id is
  // fine (or absent), else an authored message.
  const fixedColorProblem = async (rec: Record<string, unknown>): Promise<string | null> => {
    const fcId = rec.fixed_color_id;
    if (typeof fcId !== "string" || !fcId) return null;
    const { data, error } = await admin.from("colors").select("id, door")
      .eq("id", fcId).eq("client_id", clientId).maybeSingle();
    if (error || !data) return "that fixed color is not in your palette — pick one from the Colors tab";
    if (data.door !== true) return "that color is not ticked for Doors — tick it in the Colors tab first";
    return null;
  };

  // Save ONE catalog fixture. Update is IN PLACE by uuid — building_size_inclusions
  // references fixture ids with no FK (074), so delete+reinsert would orphan an item's
  // inclusions. Scoped by id+client_id+category: a foreign or cross-category id matches
  // nothing → 404, never a silent success. New rows go to the END of the palette
  // (max+1 per client+category — a default 0 would pin them to the top of the picker).
  if (action === "save_fixture") {
    const category = String(payload?.category ?? "").trim();
    if (!FIXTURE_CATEGORIES.has(category)) return json({ error: "invalid category" }, 400);
    const v = validateFixtureRow(payload, category, 0);
    if (v.err) return json({ error: v.err }, 400);
    { const p = await fixedColorProblem(v.rec!); if (p) return json({ error: p }, 400); }
    await filterWindowColorIds(v.rec!);
    const id = String(payload?.id ?? "").trim();
    if (id) {
      const { error, count } = await admin.from("fixture_items").update(v.rec!, { count: "exact" })
        .eq("id", id).eq("client_id", clientId).eq("category", category);
      if (error) return dbFail(req, clientId, "save that line", error);
      // Name the three ways this can match nothing, because "Item not found." sent a builder
      // round in circles on 2026-08-05: the row can be gone, or belong to another builder,
      // or — the one nobody guesses — be filed under a different category than the tab it is
      // being saved from, since the update is scoped by category too.
      if (!count) {
        return json({ error: `That ${category} is no longer in ${clientId}'s catalog — it may have been deleted, or it is saved under a different category. Reload the page and try again.` }, 404);
      }
      return json({ ok: true, id });
    }
    const { data: maxRow } = await admin.from("fixture_items").select("sort_order")
      .eq("client_id", clientId).eq("category", category)
      .order("sort_order", { ascending: false }).limit(1).maybeSingle();
    v.rec!.sort_order = ((maxRow?.sort_order as number) ?? -1) + 1;
    const ins = await admin.from("fixture_items").insert(fixtureInsertDefaults(v.rec!)).select("id").maybeSingle();
    if (ins.error) return dbFail(req, clientId, "add that line", ins.error);
    return json({ ok: true, id: ins.data!.id });
  }

  // Delete ONE catalog fixture. Deliberately does NOT clean building_size_inclusions —
  // 074 documents stale fixture-id inclusion rows as benign, and the legacy full-replace
  // delete leaves them too. Placed instances on saved designs keep rendering from their
  // own snapshot.
  if (action === "delete_fixture") {
    const id = String(payload?.id ?? "").trim();
    // A row the page never managed to save has no id, and the old wording ("id is required")
    // read as a bug in the app rather than as "this line was never saved".
    if (!id) return json({ error: "That line was never saved, so there is nothing to delete — reload the page to clear it." }, 400);
    const { error, count } = await admin.from("fixture_items").delete({ count: "exact" })
      .eq("id", id).eq("client_id", clientId);
    if (error) return dbFail(req, clientId, "delete that line", error);
    // Already gone is the common case and is harmless — say so rather than implying failure.
    if (!count) return json({ error: `That item is not in ${clientId}'s catalog any more — it was probably already deleted. Reload the page.` }, 404);
    return json({ ok: true });
  }

  // Persist drag-reorder of a category's fixtures (mirrors reorder_styles). sort_order
  // drives the designer's picker order via get_fixtures.
  if (action === "reorder_fixtures") {
    const category = String(payload?.category ?? "").trim();
    if (!FIXTURE_CATEGORIES.has(category)) return json({ error: "invalid category" }, 400);
    if (!Array.isArray(payload.orderedIds) || payload.orderedIds.length === 0) return json({ error: "orderedIds[] required" }, 400);
    { const e = tooMany(payload.orderedIds, "items to reorder"); if (e) return json({ error: e }, 400); }
    let i = 0;
    for (const fid of payload.orderedIds) {
      const sid = String(fid ?? "").trim();
      if (!sid) continue;
      const { error } = await admin.from("fixture_items").update({ sort_order: i })
        .eq("client_id", clientId).eq("category", category).eq("id", sid);
      if (error) return dbFail(req, clientId, "reorder those lines", error);
      i++;
    }
    return json({ ok: true });
  }

  // Spreadsheet import (Export → edit in Excel → re-upload). UPSERT-ONLY by design: rows
  // with a known id update in place, rows without one insert at the end; rows absent from
  // the file are NEVER deleted (a partial or filtered sheet must not wipe the catalog —
  // deletes happen only in the UI). The same shape holds column-wise (audit 2026-08-20):
  // the client omits keys for columns the sheet doesn't have, and validateFixtureRow's
  // presence gate leaves those fields — photos, flags, swing/op — untouched on ID-matched
  // rows, so a trimmed sheet edits only what it carries.
  if (action === "import_fixtures") {
    const category = String(payload?.category ?? "").trim();
    if (!FIXTURE_CATEGORIES.has(category)) return json({ error: "invalid category" }, 400);
    if (!Array.isArray(payload.rows)) return json({ error: "rows[] required" }, 400);
    if (payload.rows.length > 500) return json({ error: "too many rows (max 500)" }, 400);   // stricter than MAX_BULK_ROWS on purpose
    const exRes = await admin.from("fixture_items").select("id, sort_order").eq("client_id", clientId).eq("category", category);
    if (exRes.error) return dbFail(req, clientId, "read your current catalog lines", exRes.error);
    const existingIds = new Set((exRes.data ?? []).map((r: any) => String(r.id)));
    let nextSort = (exRes.data ?? []).reduce((m: number, r: any) => Math.max(m, Number(r.sort_order) || 0), -1) + 1;
    // Door-flagged palette ids, prefetched ONCE so fixed-color ids check without a query
    // per row. An invalid id is cleared with a note — never a skipped row (the rest of the
    // line is fine; blocking a 500-row import on one stale color label helps nobody).
    let doorColorIds: Set<string> | null = null;
    if (category === "door") {
      const dc = await admin.from("colors").select("id").eq("client_id", clientId).eq("door", true);
      if (dc.error) return dbFail(req, clientId, "read your door colors", dc.error);
      doorColorIds = new Set((dc.data ?? []).map((r: any) => String(r.id)));
    }
    // Same prefetch for window colors: availability lists are filtered per row below.
    let windowColorIds: Set<string> | null = null;
    if (category === "window") {
      const wc = await admin.from("window_colors").select("id").eq("client_id", clientId);
      if (wc.error) return dbFail(req, clientId, "read your window colors", wc.error);
      windowColorIds = new Set((wc.data ?? []).map((r: any) => String(r.id)));
    }
    let saved = 0, added = 0; const skipped: string[] = [];
    let i = 0;
    for (const row of payload.rows) {
      const v = validateFixtureRow(row, category, i);
      if (v.err) { skipped.push(v.err); i++; continue; }
      const fcId = v.rec!.fixed_color_id;
      if (doorColorIds && typeof fcId === "string" && fcId && !doorColorIds.has(fcId)) {
        skipped.push(`${String(row?.name ?? "row " + (i + 1))}: fixed color not in your door palette — cleared`);
        v.rec!.fixed_color_id = null;
      }
      if (windowColorIds && Array.isArray(v.rec!.window_color_ids)) {
        const before = (v.rec!.window_color_ids as unknown[]).length;
        v.rec!.window_color_ids = (v.rec!.window_color_ids as unknown[]).filter((x) => windowColorIds!.has(String(x)));
        if ((v.rec!.window_color_ids as unknown[]).length < before) {
          skipped.push(`${String(row?.name ?? "row " + (i + 1))}: some colors aren't in your window color list — dropped`);
        }
      }
      const rid = String(row?.id ?? "").trim();
      if (rid && existingIds.has(rid)) {
        const res = await admin.from("fixture_items").update(v.rec!)
          .eq("id", rid).eq("client_id", clientId).eq("category", category);
        if (res.error) { skipped.push(`${String(row?.name ?? "row " + (i + 1))}: ${res.error.message}`); i++; continue; }
        saved++;
      } else {
        v.rec!.sort_order = nextSort++;
        const res = await admin.from("fixture_items").insert(fixtureInsertDefaults(v.rec!));
        if (res.error) { skipped.push(`${String(row?.name ?? "row " + (i + 1))}: ${res.error.message}`); i++; continue; }
        added++;
      }
      i++;
    }
    return json({ ok: true, saved, added, skipped });
  }

  // Archive / un-archive a BUILT-IN layout option (singleDoor/doubleDoor/window/ramp/…). Archived =
  // retired from new builds but still rendered on old designs (get_config keeps it, flagged
  // noPalette+archived). Distinct from active=false (which removes it). clientId is JWT-resolved.
  if (action === "set_layout_item_archived") {
    const key = String(payload?.itemKey ?? "").trim();
    if (!key) return json({ error: "itemKey required" }, 400);
    const archived = payload?.archived === true;
    const { error } = await admin.from("client_layout_items")
      .update({ archived }).eq("client_id", clientId).eq("item_key", key);
    if (error) return dbFail(req, clientId, "archive that option", error);
    return json({ ok: true });
  }

  // Flag a BUILT-IN layout option as INTERNAL-designer-only. When on, the item is still placeable
  // in the embedded (rep) designer and still renders on saved designs, but is dropped from the
  // client-facing designer's palette (get_config emits internalOnly; the designer filters by
  // `embedded`). Independent of active/archived. clientId is JWT-resolved.
  if (action === "set_layout_item_internal_only") {
    const key = String(payload?.itemKey ?? "").trim();
    if (!key) return json({ error: "itemKey required" }, 400);
    const internalOnly = payload?.internalOnly === true;
    const { error } = await admin.from("client_layout_items")
      .update({ internal_only: internalOnly }).eq("client_id", clientId).eq("item_key", key);
    if (error) return dbFail(req, clientId, "update that option", error);
    return json({ ok: true });
  }

  // Whether this option's estimate line carries sales tax (migration 148). A single-flag
  // action, mirroring set_layout_item_internal_only above rather than threading taxability
  // through a bulk save the options list does not otherwise have. clientId is JWT-resolved.
  if (action === "set_layout_item_taxable") {
    const key = String(payload?.itemKey ?? "").trim();
    if (!key) return json({ error: "itemKey required" }, 400);
    const taxable = payload?.taxable !== false;
    const { error } = await admin.from("client_layout_items")
      .update({ taxable }).eq("client_id", clientId).eq("item_key", key);
    if (error) return dbFail(req, clientId, "update that option", error);
    return json({ ok: true });
  }

  // Ramp mode + simple-ramp config (Options → Ramps). Updates client_settings only.
  // mode 'simple'|'custom'; method 'each'|'per_ft'; price/photo optional (photo already
  // uploaded via upload_fixture_image and passed here as imageUrl). clientId is JWT-resolved.
  if (action === "save_ramp_settings") {
    const p = payload || {};
    const mode = (p.mode === "custom") ? "custom" : "simple";
    const method = (p.method === "per_ft") ? "per_ft" : "each";
    const priceNum = (() => { const s = String(p.price ?? "").replace(/[$,\s]/g, ""); if (s === "") return null; const n = Number(s); return Number.isFinite(n) && n >= 0 ? n : null; })();
    const updates: Record<string, unknown> = {
      client_id: clientId,
      ramp_mode: mode,
      ramp_price_method: method,
      ramp_price: priceNum,
      ramp_show_image: p.showImage !== false,
      updated_at: new Date().toISOString(),
    };
    // Whether the tenant OFFERS a ramp at all — the designer places ramps only when this is on.
    // Only overwrite when the caller sends it, so an older client doesn't blank it.
    if (Object.prototype.hasOwnProperty.call(p, "enabled")) updates.ramp_enabled = p.enabled === true;
    if (Object.prototype.hasOwnProperty.call(p, "imageUrl")) updates.ramp_image_url = String(p.imageUrl ?? "").trim() || null;
    const { error } = await admin.from("client_settings").upsert(updates, { onConflict: "client_id" });
    if (error) return dbFail(req, clientId, "save your ramp settings", error);
    return json({ ok: true });
  }

  // ═══ Inventory (migration 075) ══════════════════════════════════════════════
  // Physical buildings on the builder's sales lots. The unit's design is a designs row
  // with status='inventory' created HERE (service role) — the anon save_design RPC can
  // never mint one. Each unit takes the next number in the tenant's ONE shared serial
  // sequence (take_next_serial — Orders will draw from the same counter later).

  // ── Sales locations (Settings → Branding) ───────────────────────────────────
  if (action === "list_locations") {
    const [locs, units] = await Promise.all([
      admin.from("builder_locations").select("id, name, street, city, state, zip, active, sort_order")
        .eq("client_id", clientId).eq("active", true).order("sort_order").order("created_at"),
      admin.from("inventory_units").select("location_id").eq("client_id", clientId),
    ]);
    if (locs.error) return dbFail(req, clientId, "load your locations", locs.error);
    const counts: Record<string, number> = {};
    for (const u of units.data ?? []) { if (u.location_id) counts[u.location_id] = (counts[u.location_id] || 0) + 1; }
    let locations = (locs.data ?? []).map((l: any) => ({ ...l, buildings: counts[l.id] || 0 }));
    // TAX FIELDS (migration 245), ADDITIVE, and only for a caller who can read settings_crm —
    // the area that owns the rates. This action is also the Inventory tab's lot picker, reached
    // on inventory:view alone, and a person holding only that has no business with the rates.
    // Its own read, and TOLERANT: this list is the Settings card and the Inventory picker, so a
    // deploy ahead of 245 must lose the tax fields, not the lots (the `status` fallback-select
    // precedent). A failure is logged and the fields are simply left off.
    if (canRead("settings_crm") && locations.length) {
      const taxRes = await admin.from("builder_locations").select("id, state, zip, tax_rate, tax_label")
        .eq("client_id", clientId).eq("active", true);
      if (taxRes.error) {
        logEdgeError({
          fn: "portal-settings", req, clientId, code: taxRes.error.code ?? "location_tax_read_failed",
          message: `list_locations tax read failed: ${taxRes.error.message ?? "unknown"}`,
        }).catch(() => {});
      } else {
        const byId = new Map((taxRes.data ?? []).map((t: any) => [String(t.id), t]));
        locations = locations.map((l: any) => {
          const t = byId.get(String(l.id));
          const view = t ? locationTaxView(t) : null;
          return { ...l, taxRatePct: view?.taxRatePct ?? null, taxLabel: view?.taxLabel ?? null, taxReady: locationTaxReady(l) };
        });
      }
    }
    // nextSerial rides along so the Settings card renders both blocks from one call.
    const { data: cs } = await admin.from("client_settings").select("next_serial").eq("client_id", clientId).maybeSingle();
    return json({ ok: true, locations, nextSerial: cs?.next_serial ?? null });
  }

  if (action === "save_location") {
    const name = String(payload.name ?? "").trim().slice(0, 120);
    if (!name) return json({ error: "Location name is required." }, 400);
    const str = (v: unknown, max: number) => { const s = String(v ?? "").trim().slice(0, max); return s || null; };
    const row: Record<string, unknown> = {
      client_id: clientId, name,
      street: str(payload.street, 200), city: str(payload.city, 100),
      state: str(payload.state, 60), zip: str(payload.zip, 12),
      updated_at: new Date().toISOString(),
    };
    const id = String(payload.id ?? "").trim();
    if (id) {
      // Scoped by BOTH id and client_id — an id from another tenant matches nothing.
      const { error, count } = await admin.from("builder_locations").update(row, { count: "exact" })
        .eq("id", id).eq("client_id", clientId);
      if (error) return dbFail(req, clientId, "save that location", error);
      if (!count) return json({ error: "Location not found." }, 404);
      return json({ ok: true, id });
    }
    const { data: maxRow } = await admin.from("builder_locations").select("sort_order")
      .eq("client_id", clientId).order("sort_order", { ascending: false }).limit(1).maybeSingle();
    row.sort_order = ((maxRow?.sort_order as number) ?? -1) + 1;
    const ins = await admin.from("builder_locations").insert(row).select("id").maybeSingle();
    if (ins.error) return dbFail(req, clientId, "add that location", ins.error);
    return json({ ok: true, id: ins.data!.id });
  }

  if (action === "delete_location") {
    const id = String(payload.id ?? "").trim();
    if (!id) return json({ error: "id is required." }, 400);
    // Units at this location keep existing — their location_id FK is ON DELETE SET NULL,
    // so they show "no location" rather than blocking the delete or vanishing. Quotes sold from
    // it lose their sales_location_id the same way (migration 245): an issued, unsigned one
    // falls to the company rate on its next re-stamp (a verified rate is kept), and a signed
    // order keeps its agreed tax (see save_location_tax below).
    const { error, count } = await admin.from("builder_locations").delete({ count: "exact" })
      .eq("id", id).eq("client_id", clientId);
    if (error) return dbFail(req, clientId, "delete that location", error);
    if (!count) return json({ error: "Location not found." }, 404);
    return json({ ok: true });
  }

  // ── Sales tax settings (migrations 244-245) ─────────────────────────────────
  // One read for the tax card: who issues the paperwork, the company rate, each location's
  // local rate, and whether verified lookups are switched on for this tenant. `configured` says
  // only whether the platform holds Avalara credentials — a boolean, never the credentials or
  // the account behind them. No prices: both tax meters are disarmed, and a price read, when one
  // is needed, follows the catalog action's redaction rather than riding a settings payload.
  //
  // Every location is listed, inactive ones too, with `active` on each: an inactive lot never
  // prices a quote (taxChain), and the card should be able to say why a rate is not applying.
  // `usage24h` is null when the ledger cannot be counted — unknown, not zero.
  if (action === "tax_settings") {
    const [csRes, locRes, usage24h] = await Promise.all([
      admin.from("client_settings").select("invoice_in_ghl, ss_tax_rate, ss_tax_label, tax_lookup_enabled")
        .eq("client_id", clientId).maybeSingle(),
      admin.from("builder_locations").select(LOCATION_TAX_COLUMNS)
        .eq("client_id", clientId).order("sort_order").order("created_at"),
      countLookups24h(admin, clientId),
    ]);
    if (csRes.error) return dbFail(req, clientId, "load your tax settings", csRes.error);
    if (locRes.error) return dbFail(req, clientId, "load your locations' tax rates", locRes.error);
    const cs = csRes.data;
    return json({
      ok: true,
      // Same reading as status's invoiceInGhl: a row predating the column is CRM mode.
      ssMode: cs?.invoice_in_ghl === false,
      lookupEnabled: cs?.tax_lookup_enabled === true,
      configured: avalaraConfigured(),
      companyRatePct: ratePct(cs?.ss_tax_rate),
      companyLabel: cs?.ss_tax_label ?? "Sales tax",
      dailyCap: DAILY_TAX_LOOKUP_CAP,
      usage24h,
      locations: (locRes.data ?? []).map(locationTaxView),
    });
  }

  // A location's local rate. Its own action rather than a field on save_location, which is
  // gated settings_branding: a rate printed on every quote from that lot is a money setting, and
  // belongs with the company rate's area. Blank clears it (the lot then uses the company rate);
  // an explicit 0 is kept. A rate is refused on a lot with no usable state + ZIP (see
  // _shared/locationTax.ts) — clearing one never is.
  // WHAT A RATE CHANGE DOES TO QUOTES. This action writes no quote, but it is not inert:
  //   - an UNSIGNED quote sold from this lot keeps the tax already stamped on it only until it
  //     is next re-stamped. Its next resubmit from the designer (by staff or by the customer),
  //     or staff re-picking its location, prices it at the new rate (a cleared rate: the
  //     company rate), and a customer who already holds that quote is issued the new total the
  //     way any revision is;
  //   - a quote carrying a VERIFIED rate keeps it through those re-stamps (taxChain
  //     carryDecision), unless staff move its delivery state or ZIP;
  //   - a SIGNED order never moves. Its change orders and amendments carry the tax the customer
  //     agreed to (taxChain agreedTax), so a rate edited or cleared here, or the lot deleted,
  //     raises no tax line on a change order. Only a deliberate feature may re-rate a signed
  //     order, never this side effect.
  if (action === "save_location_tax") {
    const parsed = parseSaveLocationTax(payload);
    if (!parsed.ok) return json({ error: parsed.error, reason: parsed.reason }, parsed.status);
    const { locationId, rate, label } = parsed.value;
    const { data: cur, error: curErr } = await admin.from("builder_locations").select(LOCATION_TAX_COLUMNS)
      .eq("client_id", clientId).eq("id", locationId).maybeSingle();
    if (curErr) return dbFail(req, clientId, "load that location", curErr);
    if (!cur) return json({ error: "Location not found.", reason: "location_not_found" }, 404);
    if (rate != null && !locationTaxReady(cur)) {
      return json({
        error: "Add this location's state and ZIP code before giving it a tax rate — a local rate has to belong to a place.",
        reason: "location_address",
      }, 400);
    }
    const updates: Record<string, unknown> = { tax_rate: rate, updated_at: new Date().toISOString() };
    if (label !== undefined) updates.tax_label = label;
    // Scoped by BOTH id and client_id, like save_location: another tenant's id matches nothing.
    const { data: saved, error: saveErr } = await admin.from("builder_locations").update(updates)
      .eq("client_id", clientId).eq("id", locationId).select(LOCATION_TAX_COLUMNS).maybeSingle();
    if (saveErr) return dbFail(req, clientId, "save that location's tax rate", saveErr);
    if (!saved) return json({ error: "Location not found.", reason: "location_not_found" }, 404);
    await audit("portal_save_location_tax", 1, `location=${locationId} rate=${rate ?? "none"}${label !== undefined ? " label" : ""}`);
    return json({ ok: true, location: locationTaxView(saved) });
  }

  // ── Tax codes (migration 246, 2026-09-17) ───────────────────────────────────────────────────
  // Settings → Company → Tax: which Avalara tax code each building style and option heading
  // falls under, chosen by the builder (or their accountant) so the codes match how they file.
  // SAVED ONLY: no quote, PDF, acceptance, QuickBooks push or change order reads the mapping yet —
  // per-line tax by code is a later stage, and the card says so. The codes come from the platform
  // catalog (avalara_tax_codes), which an operator fills from Avalara (admin-catalog
  // avalara_sync_tax_codes); nothing here calls Avalara. Headings, starter codes, parsing and the
  // save plan are _shared/taxCodes.ts.
  //
  // tax_codes_get's answer, and tax_codes_save's: a save hands back what the database now holds,
  // not an echo of what was sent. `hint` rides on the common codes (the picker's empty-box list)
  // and `headingGroups` names the heading groups in order — both additive to the brief's shape.
  const taxCodesResponse = async (): Promise<Response> => {
    const [csRes, stylesRes, storedRes, countRes, syncRes] = await Promise.all([
      admin.from("client_settings").select("invoice_in_ghl, tax_lookup_enabled").eq("client_id", clientId).maybeSingle(),
      admin.from("building_styles").select("id, label, active, sort_order").eq("client_id", clientId)
        .order("active", { ascending: false }).order("sort_order").order("label"),
      admin.from("tax_code_assignments").select("target_type, target_key, tax_code").eq("client_id", clientId),
      admin.from("avalara_tax_codes").select("code", { count: "exact", head: true }),
      admin.from("avalara_tax_codes").select("synced_at").not("synced_at", "is", null)
        .order("synced_at", { ascending: false }).limit(1).maybeSingle(),
    ]);
    if (csRes.error) return dbFail(req, clientId, "load your tax settings", csRes.error);
    if (stylesRes.error) return dbFail(req, clientId, "load your building styles", stylesRes.error);
    if (storedRes.error) return dbFail(req, clientId, "load your tax codes", storedRes.error);
    if (countRes.error) return dbFail(req, clientId, "load the tax code list", countRes.error);
    if (syncRes.error) return dbFail(req, clientId, "load the tax code list", syncRes.error);

    // deno-lint-ignore no-explicit-any
    const styles = (stylesRes.data ?? []).map((s: any) => ({ id: String(s.id).toLowerCase(), label: s.label ?? "", active: s.active === true }));
    const assignments = visibleAssignments(storedRes.data ?? [], new Set(styles.map((s) => s.id)));
    // Every assigned code's details (an inactive one included, so the card can say it needs
    // changing) plus the common codes the picker opens on.
    const wanted = [...new Set([...COMMON_CODES.map((c) => c.code), ...assignments.map((a) => a.code)])];
    const codesRes = await admin.from("avalara_tax_codes").select("code, description, type_id, is_active").in("code", wanted);
    if (codesRes.error) return dbFail(req, clientId, "load the tax code list", codesRes.error);

    return json({
      ok: true,
      // Same readings as tax_settings: a row predating either column is CRM mode / lookups off.
      ssMode: csRes.data?.invoice_in_ghl === false,
      lookupEnabled: csRes.data?.tax_lookup_enabled === true,
      headings: headingsView(),
      headingGroups: TAX_HEADING_GROUPS,
      styles,
      assignments,
      codes: orderCodes((codesRes.data ?? []).map(taxCodeView)),
      catalog: { count: countRes.count ?? 0, syncedAt: syncRes.data?.synced_at ?? null },
    });
  };

  if (action === "tax_codes_get") return await taxCodesResponse();

  // The picker's type-ahead, over the stored catalog. Active codes only; the codes Avalara marks
  // not applicable to North America are left out unless `includeAll`. An empty box lists the
  // common codes first. Two queries rather than one `or=` filter: typed text inside an or-filter
  // string would need PostgREST's quoting rules for commas, dots and parentheses, while a plain
  // ilike filter takes the value as it is (searchQuery escapes the pattern characters).
  if (action === "tax_codes_search") {
    const q = searchQuery(payload?.q);
    const includeAll = payload?.includeAll === true;
    const columns = "code, description, type_id, is_active";
    const active = () => {
      const b = admin.from("avalara_tax_codes").select(columns).eq("is_active", true);
      return includeAll ? b : b.eq("north_america", true);
    };
    const [firstRes, secondRes] = await Promise.all(q
      ? [
        active().ilike("code", `${q}%`).order("code").limit(TAX_CODE_SEARCH_LIMIT),
        active().ilike("description", `%${q}%`).order("code").limit(TAX_CODE_SEARCH_LIMIT),
      ]
      : [
        active().in("code", COMMON_CODES.map((c) => c.code)),
        active().order("code").limit(TAX_CODE_SEARCH_LIMIT),
      ]);
    if (firstRes.error) return dbFail(req, clientId, "search the tax codes", firstRes.error);
    if (secondRes.error) return dbFail(req, clientId, "search the tax codes", secondRes.error);
    const first = (firstRes.data ?? []).map(taxCodeView);
    const second = (secondRes.data ?? []).map(taxCodeView);
    return json({ ok: true, codes: mergeCodeLists(q ? first : orderCodes(first), second) });
  }

  // Replace the tenant's whole mapping with exactly the payload's. Validated in full BEFORE any
  // write: the shape (parseAssignmentsPayload), every code present and active in the catalog,
  // every style this tenant's. Then new or changed targets are upserted and targets no longer
  // covered are deleted — upsert first, so a failure between the two leaves an old assignment
  // behind rather than losing one the builder kept. Unchanged targets are not rewritten, so
  // updated_by keeps naming whoever last changed each one (an operator's own id in view-as, whose
  // write is also on the operator_tax_codes_save audit row above).
  //
  // The writes do not trust the read they were planned from. Two editors saving at once each
  // plan against what they read; a delete limited to the rows that read contained left the
  // OTHER save's new rows behind, so the table held both payloads (doors from one, windows from
  // the other) though each asked for a whole set. So: a target this save keeps unchanged is
  // re-inserted if it has gone missing (DO NOTHING when present, so its updated_by stands), and
  // the delete removes every row of this tenant's that this payload does NOT cover, whatever the
  // read saw. A save whose writes all land after another's leaves exactly its own targets (a code it
  // left unchanged keeps the other save's change to it, if any). Two saves whose writes
  // interleave inside one round trip can still leave a mix — there is no transaction here to
  // prevent that — and the answer is what the database now holds, so the editor sees it.
  if (action === "tax_codes_save") {
    const parsed = parseAssignmentsPayload(payload);
    if (!parsed.ok) return json({ error: parsed.error, reason: parsed.reason }, parsed.status);
    const rows = parsed.rows;

    const codes = [...new Set(rows.map((r) => r.code))];
    if (codes.length) {
      const { data, error } = await admin.from("avalara_tax_codes").select("code, is_active").in("code", codes);
      if (error) return dbFail(req, clientId, "check those tax codes", error);
      // deno-lint-ignore no-explicit-any
      const active = new Map((data ?? []).map((c: any) => [String(c.code), c.is_active === true]));
      for (const code of codes) {
        if (active.get(code) === true) continue;
        return json({
          error: active.has(code)
            ? `Tax code ${code} is no longer active in Avalara's list — pick another code for that row.`
            : `Tax code ${code} isn't in the Avalara tax code list — pick a code from the list.`,
          reason: "unknown_code",
        }, 400);
      }
    }

    const styleIds = [...new Set(rows.flatMap((r) => r.targets.filter((t) => t.type === "style").map((t) => t.key)))];
    if (styleIds.length) {
      const { data, error } = await admin.from("building_styles").select("id").eq("client_id", clientId).in("id", styleIds);
      if (error) return dbFail(req, clientId, "check your building styles", error);
      // deno-lint-ignore no-explicit-any
      const mine = new Set((data ?? []).map((s: any) => String(s.id).toLowerCase()));
      if (styleIds.some((id) => !mine.has(id))) {
        return json({
          error: "One of those buildings is no longer one of your building styles — reload the page and try again.",
          reason: "unknown_style",
        }, 400);
      }
    }

    const { data: stored, error: storedErr } = await admin.from("tax_code_assignments")
      .select("target_type, target_key, tax_code").eq("client_id", clientId);
    if (storedErr) return dbFail(req, clientId, "load your tax codes", storedErr);
    const plan = planAssignments(stored ?? [], rows);

    const now = new Date().toISOString();
    const stamp = (a: PlannedAssignment) => ({ ...a, client_id: clientId, updated_at: now, updated_by: userId ?? null });
    if (plan.upserts.length) {
      const { error } = await admin.from("tax_code_assignments").upsert(
        plan.upserts.map(stamp), { onConflict: "client_id,target_type,target_key" },
      );
      if (error) return dbFail(req, clientId, "save your tax codes", error);
    }
    if (plan.kept.length) {
      const { error } = await admin.from("tax_code_assignments").upsert(
        plan.kept.map(stamp), { onConflict: "client_id,target_type,target_key", ignoreDuplicates: true },
      );
      if (error) return dbFail(req, clientId, "save your tax codes", error);
    }
    // By exclusion, per type, always run. The keys are safe inside the quoted in-list: a style
    // key passed the uuid shape and a heading key is one of TAX_HEADINGS' (parseAssignmentsPayload).
    let removed = 0;
    for (const [type, keys] of [["style", plan.keepStyles], ["heading", plan.keepHeadings]] as const) {
      let del = admin.from("tax_code_assignments").delete({ count: "exact" })
        .eq("client_id", clientId).eq("target_type", type);
      if (keys.length) del = del.not("target_key", "in", `(${keys.map((k) => `"${k}"`).join(",")})`);
      const { error, count } = await del;
      if (error) return dbFail(req, clientId, "remove the tax codes you unticked", error);
      removed += count ?? 0;
    }

    await audit("portal_tax_codes_save", plan.upserts.length + removed,
      `codes=${codes.join(",").slice(0, 400)} changed=${plan.upserts.length} removed=${removed} unchanged=${plan.kept.length}`);
    return await taxCodesResponse();
  }

  // ── Serial sequence starting number ──────────────────────────────────────────
  if (action === "save_serial_start") {
    const n = Math.round(Number(payload.nextSerial));
    if (!Number.isFinite(n) || n < 1 || n > 999_999_999) {
      return json({ error: "Next serial must be a whole number from 1 to 999,999,999." }, 400);
    }
    // Never allow a restart that could re-mint an already-used number: the sequence is
    // shared with Orders later, and a duplicate serial on two physical buildings is the
    // exact confusion serials exist to prevent.
    const { data: maxU } = await admin.from("inventory_units").select("serial")
      .eq("client_id", clientId).order("serial", { ascending: false }).limit(1).maybeSingle();
    const { data: csCur } = await admin.from("client_settings")
      .select("next_serial").eq("client_id", clientId).maybeSingle();
    const maxUsed = Number(maxU?.serial) || 0;
    const cur = Number(csCur?.next_serial) || 0;
    // The counter itself is a floor, not just the highest SURVIVING unit: deleting the
    // newest building would otherwise reopen its number, and the delete deliberately KEEPS
    // the customer estimates that quote it — two different buildings would then share a
    // serial across quotes and the shop's paper trail. A first-time set (counter never
    // configured, cur = 0) is unconstrained, which is the "we're already at #12,000" case.
    const floor = Math.max(maxUsed + 1, cur);
    if (cur > 0 && n < floor) {
      return json({ error: `The next serial must be at least ${floor} — numbers already issued can never be reused.` }, 400);
    }
    const { error } = await admin.from("client_settings").upsert(
      { client_id: clientId, next_serial: n, updated_at: new Date().toISOString() },
      { onConflict: "client_id" });
    if (error) return dbFail(req, clientId, "save your next serial number", error);
    await audit("portal_save_serial_start", 1, `next_serial=${n}`);
    return json({ ok: true, nextSerial: n });
  }

  // ── Create / update an inventory unit (Designer → "Save to Inventory") ──────
  if (action === "save_inventory") {
    const SHORT_CODE = /^SS-[A-HJ-NP-Z2-9]{6,12}$/;
    // Master-design payload — same shape save_design takes, minus contact (no customer).
    const design = {
      selections: payload.selections ?? {},
      paint_colors: payload.paintColors ?? {},
      items: Array.isArray(payload.items) ? payload.items : [],
      custom_options: Array.isArray(payload.customOptions) ? payload.customOptions : [],
      ro_dimensions: payload.roDimensions ?? {},
      bldg_w: Number(payload.bldgW) || null,
      bldg_h: Number(payload.bldgH) || null,
    };
    // Same trust rule as migration 070's sanitizer: a stored image_url must be OUR
    // public floor-plans URL under THIS tenant's prefix, or it becomes null.
    const rawImg = String(payload.imageUrl ?? "").trim();
    const imgOk = rawImg.startsWith(`${Deno.env.get("SUPABASE_URL")}${OBJECT_PATH}${clientId}/`) &&
      /\.(pdf|png)$/.test(rawImg);
    const imageUrl = imgOk ? rawImg : null;
    if (!Number.isFinite(design.bldg_w as number) || !Number.isFinite(design.bldg_h as number)
        || (design.bldg_w as number) <= 0 || (design.bldg_h as number) <= 0) {
      return json({ error: "Pick a building style and size before saving to inventory." }, 400);
    }
    const priceRaw = payload.askingPriceCents;
    const askingPriceCents = priceRaw == null || priceRaw === "" ? null : Math.round(Number(priceRaw));
    if (askingPriceCents !== null && (!Number.isFinite(askingPriceCents) || askingPriceCents < 0)) {
      return json({ error: "askingPriceCents must be a non-negative integer." }, 400);
    }
    let locationId: string | null = String(payload.locationId ?? "").trim() || null;
    if (locationId) {
      const { data: loc } = await admin.from("builder_locations").select("id")
        .eq("id", locationId).eq("client_id", clientId).maybeSingle();
      if (!loc) return json({ error: "Unknown location." }, 400);
    }

    const unitId = String(payload.unitId ?? "").trim();
    if (unitId) {
      // UPDATE mode: re-save the master design (the builder edited the building) and/or
      // the unit fields. Serial never changes.
      const { data: unit } = await admin.from("inventory_units")
        .select("id, design_short_code").eq("id", unitId).eq("client_id", clientId).maybeSingle();
      if (!unit) return json({ error: "Inventory unit not found." }, 404);
      const dPatch: Record<string, unknown> = { ...design, updated_at: new Date().toISOString() };
      if (imageUrl) dPatch.image_url = imageUrl;   // null never blanks an existing PDF
      const dUp = await admin.from("designs").update(dPatch)
        .eq("client_id", clientId).eq("short_code", unit.design_short_code).eq("status", "inventory");
      if (dUp.error) return dbFail(req, clientId, "save that building", dUp.error);
      // Version append mirrors save_design's history contract.
      const { data: vMax } = await admin.from("design_versions").select("version")
        .eq("short_code", unit.design_short_code).order("version", { ascending: false }).limit(1).maybeSingle();
      await admin.from("design_versions").insert({
        short_code: unit.design_short_code, client_id: clientId,
        version: (Number(vMax?.version) || 0) + 1, contact: {},
        ...design, image_url: imageUrl,
      });
      const uPatch: Record<string, unknown> = { updated_at: new Date().toISOString() };
      if (Object.prototype.hasOwnProperty.call(payload, "askingPriceCents")) uPatch.asking_price_cents = askingPriceCents;
      if (Object.prototype.hasOwnProperty.call(payload, "locationId")) uPatch.location_id = locationId;
      const uUp = await admin.from("inventory_units").update(uPatch).eq("id", unitId).eq("client_id", clientId);
      if (uUp.error) return dbFail(req, clientId, "save that inventory unit", uUp.error);
      await audit("portal_update_inventory", 1, `unit=${unitId}`);
      return json({ ok: true, unitId, shortCode: unit.design_short_code });
    }

    // CREATE mode.
    const shortCode = String(payload.shortCode ?? "").trim();
    if (!SHORT_CODE.test(shortCode)) return json({ error: "invalid design code" }, 400);
    const { data: exists } = await admin.from("designs").select("short_code")
      .eq("short_code", shortCode).maybeSingle();
    if (exists) return json({ error: "That design code is already in use." }, 409);

    // Serial LAST among the validations — a rejected payload must not burn a number.
    const { data: serial, error: serErr } = await admin.rpc("take_next_serial", { p_client_id: clientId });
    // `serial == null` with no error is not a database failure — take_next_serial simply
    // returned nothing — so it keeps its own sentence rather than being folded into dbFail.
    if (serErr) return dbFail(req, clientId, "get the next serial number", serErr);
    if (serial == null) return json({ error: "Could not assign a serial number." }, 500);

    const dIns = await admin.from("designs").insert({
      short_code: shortCode, client_id: clientId, status: "inventory",
      contact: {}, ...design, image_url: imageUrl,
    });
    if (dIns.error) return dbFail(req, clientId, "create that building", dIns.error);
    await admin.from("design_versions").insert({
      short_code: shortCode, client_id: clientId, version: 1, contact: {},
      ...design, image_url: imageUrl,
    });
    const uIns = await admin.from("inventory_units").insert({
      client_id: clientId, serial, design_short_code: shortCode,
      location_id: locationId, asking_price_cents: askingPriceCents,
      // Saving to Inventory IS the request. It reads `requested` until somebody puts it on
      // the Build Schedule — that act is the approval (migration 105), so there is no flag
      // here to fall out of step with the board.
      sale_state: "unsold",
    }).select("id").maybeSingle();
    if (uIns.error) {
      // Don't leave an orphan master behind a failed unit insert.
      await admin.from("design_versions").delete().eq("short_code", shortCode).eq("client_id", clientId);
      await admin.from("designs").delete().eq("short_code", shortCode).eq("client_id", clientId);
      return dbFail(req, clientId, "create that inventory unit", uIns.error);
    }
    await audit("portal_save_inventory", 1, `unit=${uIns.data!.id} serial=${serial}`);
    return json({ ok: true, unitId: uIns.data!.id, serial, shortCode });
  }

  // ── Unit field edits from the Inventory tab (price, lot) ────────────────────
  // The ONLY things a person edits on a building directly. Its build status comes from the
  // Build and Delivery schedules, and its sale comes from an invoice or a payment — neither
  // is settable here, or anywhere else by hand.
  if (action === "update_inventory") {
    const unitId = String(payload.unitId ?? "").trim();
    if (!unitId) return json({ error: "unitId is required." }, 400);
    // Refuse the retired field LOUDLY rather than ignoring it. A browser holding a cached
    // portal.html would otherwise send {status:"sold"}, get a 200, and not sell the
    // building — the worst possible outcome for this particular write.
    if (Object.prototype.hasOwnProperty.call(payload, "status")) {
      return json({
        error: "A building's status can't be set by hand. It follows your Build and Delivery "
          + "schedules, and it sells when you invoice it.",
      }, 400);
    }
    const patch: Record<string, unknown> = { updated_at: new Date().toISOString() };
    if (Object.prototype.hasOwnProperty.call(payload, "askingPriceCents")) {
      const v = payload.askingPriceCents;
      const cents = v == null || v === "" ? null : Math.round(Number(v));
      if (cents !== null && (!Number.isFinite(cents) || cents < 0)) return json({ error: "Invalid asking price." }, 400);
      patch.asking_price_cents = cents;
    }
    if (Object.prototype.hasOwnProperty.call(payload, "locationId")) {
      const lid = String(payload.locationId ?? "").trim() || null;
      if (lid) {
        const { data: loc } = await admin.from("builder_locations").select("id")
          .eq("id", lid).eq("client_id", clientId).maybeSingle();
        if (!loc) return json({ error: "Unknown location." }, 400);
      }
      patch.location_id = lid;
    }
    const { error, count } = await admin.from("inventory_units").update(patch, { count: "exact" })
      .eq("id", unitId).eq("client_id", clientId);
    if (error) return dbFail(req, clientId, "save that building", error);
    if (!count) return json({ error: "Inventory unit not found." }, 404);
    await audit("portal_update_inventory", 1, `unit=${unitId}`);
    return json({ ok: true });
  }

  // ── Release a sold building back onto the market ────────────────────────────
  // The ONE correction path for a sale, and the only reason it exists: there is no way to void
  // a customer invoice anywhere in this product — no action, no button, no inbound GHL
  // webhook — so a CRM-side void is invisible to us. Without this, one mis-clicked invoice
  // would take a building out of sellable stock permanently.
  //
  // It records WHICH design it was released from, and every automatic claim skips that design.
  // Without that marker this action would be theatre: the buyer's design is still `invoiced`,
  // so the very next sync would re-sell the building. A different estimate can still sell it,
  // which is the real case — a re-sale after a cancelled one comes with a new estimate anyway.
  if (action === "unsell_inventory") {
    const unitId = String(payload.unitId ?? "").trim();
    const reason = String(payload.reason ?? "").trim();
    if (!unitId) return json({ error: "unitId is required." }, 400);
    if (!reason) return json({ error: "Releasing a sold building needs a reason." }, 400);
    const { data: unit } = await admin.from("inventory_units")
      .select("id, serial, sale_state, sold_design_short_code")
      .eq("id", unitId).eq("client_id", clientId).maybeSingle();
    if (!unit) return json({ error: "Inventory unit not found." }, 404);
    if (unit.sale_state !== "sold") return json({ ok: true, already: true });
    // A delivered SALE stop means the building is standing in the customer's yard. That is
    // history, the same way a delivered load is.
    if (unit.sold_design_short_code) {
      const { data: gone } = await admin.from("delivery_stops").select("id")
        .eq("client_id", clientId).eq("inventory_unit_id", unitId)
        .eq("design_short_code", unit.sold_design_short_code)
        .not("delivered_at", "is", null).limit(1);
      if (gone?.length) {
        return json({
          error: `Building #${unit.serial} has already been delivered to its buyer — that can't be undone here.`,
        }, 409);
      }
    }
    // inventory_units_unsold_is_clean forces every one of these to null, so a partial clear
    // is rejected by the database rather than leaving a stale buyer the pool query and the
    // delivered write-back would keep acting on.
    const now = new Date().toISOString();
    const { error } = await admin.from("inventory_units").update({
      sale_state: "unsold", sold_design_short_code: null, sold_at: null,
      sold_by: null, sold_first_name: null, updated_at: now,
      // The suppression marker. Keep it OUT of the CHECK's "must be clean when unsold" set —
      // it is a record of what happened, not sale residue.
      sale_released_at: now, sale_released_from: unit.sold_design_short_code,
    }).eq("id", unitId).eq("client_id", clientId).eq("sale_state", "sold");
    if (error) return dbFail(req, clientId, "put that building back on the lot", error);
    await auditStrict("portal_unsell_inventory", 1,
      `unit=${unitId} serial=${unit.serial} was=${unit.sold_design_short_code} reason=${reason.slice(0, 500)}`);
    return json({ ok: true });
  }

  // ── Remove a unit (the master design is deleted by a follow-up delete_design) ─
  if (action === "delete_inventory") {
    const unitId = String(payload.unitId ?? "").trim();
    if (!unitId) return json({ error: "unitId is required." }, 400);
    const { data: unit } = await admin.from("inventory_units")
      .select("id, design_short_code, serial").eq("id", unitId).eq("client_id", clientId).maybeSingle();
    if (!unit) return json({ error: "Inventory unit not found." }, 404);
    // Customer estimates sent from this unit keep existing — their inventory_unit_id
    // FK nulls out. Only the unit row goes here; the portal then calls delete_design
    // for the master (reusing its storage/version cascade unchanged).
    const { error } = await admin.from("inventory_units").delete().eq("id", unitId).eq("client_id", clientId);
    if (error) return dbFail(req, clientId, "delete that building", error);

    // The master design goes with it, HERE rather than in a second call from the browser.
    // Split across two requests, a failed/abandoned second call left a status='inventory'
    // row that no surface can list (excluded from Designs, and list_inventory needs a unit
    // to find it) — an invisible orphan holding storage forever. Best-effort by design:
    // the unit row is already gone, so a storage/DB hiccup must not fail the whole delete;
    // it is reported back and logged instead.
    const code = unit.design_short_code;
    let masterDeleted = false;
    try {
      const { data: versions } = await admin.from("design_versions")
        .select("image_url").eq("client_id", clientId).eq("short_code", code);
      const { data: master } = await admin.from("designs")
        .select("image_url").eq("client_id", clientId).eq("short_code", code).maybeSingle();
      // Same two-step trust check delete_design uses: reduce the stored URL to an object
      // key, then require that key to be one THIS design could have produced. A stored
      // image_url is caller-influenced, so it may say WHICH of this design's objects to
      // remove, never whose. legacyOk=false: inventory masters postdate the bucket-root era.
      const keys = new Set<string>();
      for (const u of [master?.image_url, ...(versions ?? []).map((v: any) => v.image_url)]) {
        const key = floorPlanKey(u);
        if (key && isOwnFloorPlanKey(key, clientId, code, false)) keys.add(key);
      }
      if (keys.size) await admin.storage.from(FLOOR_PLANS).remove([...keys]);
      await admin.from("design_versions").delete().eq("client_id", clientId).eq("short_code", code);
      const { error: dErr } = await admin.from("designs").delete()
        .eq("client_id", clientId).eq("short_code", code).eq("status", "inventory");
      masterDeleted = !dErr;
      if (dErr) throw new Error(dErr.message);
    } catch (e) {
      await logEdgeError({ fn: "portal-settings", req, clientId, code: "inventory_master_orphan",
        message: `Inventory unit ${unitId} deleted but its master design ${code} did not: ${(e as Error).message}` });
    }
    await auditStrict("portal_delete_inventory", 1, `unit=${unitId} serial=${unit.serial} code=${code} master=${masterDeleted}`);
    return json({ ok: true, designShortCode: code, masterDeleted });
  }

  // ── The Inventory tab's data ─────────────────────────────────────────────────
  if (action === "list_inventory") {
    const [unitsRes, locsRes] = await Promise.all([
      admin.from("inventory_units")
        .select("id, serial, design_short_code, location_id, asking_price_cents, "
          + "sale_state, sold_design_short_code, sold_at, sold_first_name, created_at, updated_at")
        .eq("client_id", clientId).order("created_at", { ascending: false }),
      admin.from("builder_locations").select("id, name, city").eq("client_id", clientId),
    ]);
    if (unitsRes.error) return dbFail(req, clientId, "load your inventory", unitsRes.error);
    const units = unitsRes.data ?? [];
    const locById = new Map((locsRes.data ?? []).map((l: any) => [l.id, l]));
    const codes = units.map((u: any) => u.design_short_code);
    const unitIds = units.map((u: any) => u.id);
    const [mastersRes, estRes] = await Promise.all([
      codes.length
        ? admin.from("designs").select("short_code, selections, image_url, paint_colors").in("short_code", codes).eq("client_id", clientId)
        : Promise.resolve({ data: [], error: null } as any),
      // ── ROW SCOPE (migration 193) ────────────────────────────────────────────────────
      // contact_id is selected so the estimates list can be narrowed below. These are the
      // QUOTES customers have taken on a lot building and each one carries `contact` — the
      // buyer's name — so on contacts:'own' a rep would read every colleague's live deal off
      // the Inventory tab, which the sales_rep preset grants at inventory:'view'.
      unitIds.length
        ? admin.from("designs")
          .select("short_code, inventory_unit_id, contact_id, contact, status, ghl_estimate_number, created_at")
          .eq("client_id", clientId).in("inventory_unit_id", unitIds).order("created_at", { ascending: false })
        : Promise.resolve({ data: [], error: null } as any),
    ]);
    if (mastersRes.error) return dbFail(req, clientId, "load your inventory buildings", mastersRes.error);
    // Spell out the master rows' shape. The empty-input branch above is `as any`, so
    // `mastersRes.data` is `any` and a bare `new Map(rows.map(...))` has nothing to infer
    // K/V from — it quietly becomes Map<unknown, unknown>, `.get()` returns `unknown`, and
    // the truthiness / `?.` checks below narrow `unknown` to `{}`, so every field read off a
    // master was a TS2339. Those errors kept `deno check` on this function permanently
    // non-zero, which is exactly how a genuinely new type error would have gone unnoticed.
    // A `Map<string, any>` also silences them, but it makes every read here unchecked
    // forever — which defeats the point of having the gate — so name the fields instead.
    // Both jsonb columns are optional-everything: they read back null on rows that predate
    // them (roofType/roofColor and paint_colors each shipped later than the master itself),
    // and save_inventory writes `{}` when unset.
    interface MasterSelections { style?: string; size?: string; roofType?: string; roofColor?: string }
    interface MasterPaint { body?: string; trim?: string }
    interface MasterRow {
      short_code: string;
      image_url: string | null;
      selections: MasterSelections | null;
      paint_colors: MasterPaint | null;
    }
    const masterByCode = new Map<string, MasterRow>(
      ((mastersRes.data ?? []) as MasterRow[]).map((d): [string, MasterRow] => [d.short_code, d]),
    );
    // ⚠️ ONLY THE ESTIMATES ARE NARROWED — NOT `mastersRes`. A master is the builder's OWN
    // building on their OWN lot: it has no customer, its contact_id is null, and running it
    // through the same filter would drop every unit's style, size, image and colours from
    // the Inventory tab for anyone on contacts:'own'. That is the "don't filter blindly"
    // case, and the two reads sit four lines apart, so it is worth saying out loud.
    const visibleEsts = await visibleDesignRows((estRes.data ?? []) as { contact_id?: string | null; inventory_unit_id: string }[]);
    if (!visibleEsts) return dbFail(req, clientId, "check who these customers are assigned to", { message: "contact scope unavailable" });
    const estsByUnit = new Map<string, any[]>();
    for (const d of visibleEsts as any[]) {
      const list = estsByUnit.get(d.inventory_unit_id) ?? [];
      list.push({
        shortCode: d.short_code,
        name: (d.contact && d.contact.name) || "",
        status: d.status, estimateNumber: d.ghl_estimate_number, createdAt: d.created_at,
      });
      estsByUnit.set(d.inventory_unit_id, list);
    }
    // ── Build-stage facts for every unit, in three queries rather than three per unit ──
    // The ladder is derived (see _shared/inventoryLifecycle.ts), so the tab needs each unit's
    // build job, that job's stage KIND (never its tenant-editable name) and its delivery
    // stops. Fetched in bulk for the whole tab in one round trip per table.
    const [jobsRes, stopsRes] = await Promise.all([
      unitIds.length
        ? admin.from("build_jobs").select("id, inventory_unit_id, stage_id, due_date, completed_at")
          .eq("client_id", clientId).in("inventory_unit_id", unitIds)
        : Promise.resolve({ data: [], error: null } as any),
      unitIds.length
        ? admin.from("delivery_stops")
          .select("id, inventory_unit_id, design_short_code, delivered_at, load_id")
          .eq("client_id", clientId).in("inventory_unit_id", unitIds)
        : Promise.resolve({ data: [], error: null } as any),
    ]);
    interface JobRow {
      id: string;
      inventory_unit_id: string;
      stage_id: string | null;
      due_date: string | null;
      completed_at: string | null;
    }
    interface StopRow {
      id: string;
      inventory_unit_id: string;
      design_short_code: string | null;
      delivered_at: string | null;
      load_id: string | null;
    }
    const jobRows = (jobsRes.data ?? []) as JobRow[];
    const stopRows = (stopsRes.data ?? []) as StopRow[];
    const stageIds = [...new Set(jobRows.map((j) => j.stage_id).filter(Boolean))] as string[];
    const { data: stageRows } = stageIds.length
      ? await admin.from("schedule_stages").select("id, name, kind").eq("client_id", clientId).in("id", stageIds)
      : { data: [] };
    const stageById = new Map<string, { name: string; kind: StageKind }>(
      ((stageRows ?? []) as { id: string; name: string; kind: StageKind }[])
        .map((s): [string, { name: string; kind: StageKind }] => [s.id, { name: s.name, kind: s.kind }]),
    );
    const jobByUnit = new Map<string, JobRow>(jobRows.map((j): [string, JobRow] => [j.inventory_unit_id, j]));
    const stopsByUnit = new Map<string, StopRow[]>();
    for (const s of stopRows) {
      const list = stopsByUnit.get(s.inventory_unit_id) ?? [];
      list.push(s);
      stopsByUnit.set(s.inventory_unit_id, list);
    }

    const out = units.map((u: any) => {
      const m = masterByCode.get(u.design_short_code);
      // Annotated, not inferred: without it the `|| {}` fallback puts a bare `{}` into the
      // union and the reads below break again. The `||` (not `??`) is deliberate — an unset
      // jsonb column reads back as null, and a legacy row can hold "".
      const sel: MasterSelections = (m && m.selections) || {};
      const paint: MasterPaint = (m && m.paint_colors) || {};
      const loc = u.location_id ? locById.get(u.location_id) : null;

      const job = jobByUnit.get(u.id) ?? null;
      const stage = job?.stage_id ? stageById.get(job.stage_id) ?? null : null;
      const stops = stopsByUnit.get(u.id) ?? [];
      // Purely a function of the schedule rows above — there is nothing stored to fold in and
      // nothing hand-set to respect. The status this returns and the Build/Delivery boards
      // cannot disagree, because they are the same facts read twice.
      const lifecycle = deriveLifecycle({
        soldDesignShortCode: u.sold_design_short_code ?? null,
        job: job
          ? { stageKind: stage?.kind ?? null, dueDate: job.due_date ?? null, completedAt: job.completed_at ?? null }
          : null,
        stops: stops.map((s) => ({ designShortCode: s.design_short_code, deliveredAt: s.delivered_at })),
      });

      return {
        id: u.id, serial: u.serial, shortCode: u.design_short_code,
        locationId: u.location_id, locationName: loc?.name ?? null, locationCity: loc?.city ?? null,
        askingPriceCents: u.asking_price_cents,
        // ── Axis 1: where it is on the build ladder ──
        lifecycle,
        lifecycleLabel: LIFECYCLE_LABEL[lifecycle],
        // ── Axis 2: whether it is still for sale ──
        saleState: u.sale_state, soldDesignShortCode: u.sold_design_short_code,
        soldFirstName: u.sold_first_name ?? null, soldAt: u.sold_at ?? null,
        // For the ecommerce listing Carolyn plans: a sold display keeps its SOLD badge for 30
        // days and then falls off the list. Computed here so the 30 lives in ONE place.
        soldLabelExpiresAt: u.sold_at
          ? new Date(Date.parse(u.sold_at) + SOLD_LABEL_DAYS * 86400000).toISOString()
          : null,
        style: sel.style ?? null, size: sel.size ?? null, imageUrl: m?.image_url ?? null,
        roofType: sel.roofType ?? null, roofColor: sel.roofColor ?? null,
        bodyColor: paint.body ?? null, trimColor: paint.trim ?? null,
        createdAt: u.created_at, updatedAt: u.updated_at,
        estimates: estsByUnit.get(u.id) ?? [],
      };
    });
    return json({ ok: true, units: out, locations: locsRes.data ?? [], soldLabelDays: SOLD_LABEL_DAYS });
  }

  // ── After a submit from "Send estimate": tie the new design to its unit ─────
  if (action === "link_design_to_unit") {
    const shortCode = String(payload.shortCode ?? "").trim();
    // unitId NULL is meaningful, not missing input: it is how "Design a new build
    // instead" unties a quote from the building it started on, so the version just saved
    // reads New instead of inheriting Inventory.
    const rawUnit = payload.unitId;
    const unitId = rawUnit == null || rawUnit === "" ? null : String(rawUnit).trim();
    if (!shortCode) return json({ error: "shortCode is required." }, 400);
    // ROW SCOPE (207). A rep on contacts:'own' may hold designs:edit / orders:edit and
    // still not be allowed near THIS customer's building. The gate above decides what
    // KIND of thing they may do; this decides which rows. Placed before the design is
    // even read, so a refusal costs nothing and cannot leak timing.
    { const refused = await refuseUnlessDesignVisible(shortCode); if (refused) return refused; }
    if (unitId) {
      const { data: unit } = await admin.from("inventory_units")
        .select("id, serial, sale_state, sold_design_short_code, sold_first_name")
        .eq("id", unitId).eq("client_id", clientId).maybeSingle();
      if (!unit) return json({ error: "Inventory unit not found." }, 404);
      // "Once Inventory is sold it must become unavailable to sell" (Carolyn 2026-08-07),
      // enforced HERE because this is the single door every quote goes through to become an
      // estimate on a building. Until migration 102 this branch only checked the unit
      // existed, so a sold building could be quoted to a second customer and both could
      // reach accepted with nothing anywhere reporting a problem — the portal's only
      // handling was a warning span with no action attached.
      //
      // Two exemptions, both deliberate:
      //   * unitId === null is the UNTIE path ("Design a new build instead"). It must keep
      //     working on a sold unit — it is the remedy this error points people at.
      //   * the winning buyer re-linking their OWN design is not a second sale (a resubmit
      //     re-runs this call with the same code).
      if (unit.sale_state === "sold" && unit.sold_design_short_code !== shortCode) {
        const who = unit.sold_first_name ? ` to ${unit.sold_first_name}` : "";
        return json({
          error: `Building #${unit.serial} is already sold${who}. Design a new build for this customer instead.`,
        }, 409);
      }
    }
    // Never relabel the master itself, and never touch another tenant's design.
    const { error, count } = await admin.from("designs").update({ inventory_unit_id: unitId }, { count: "exact" })
      .eq("client_id", clientId).eq("short_code", shortCode).neq("status", "inventory");
    if (error) return dbFail(req, clientId, "link that design to the building", error);
    if (!count) return json({ error: "Design not found (or it is an inventory master)." }, 404);

    // Stamp the NEWEST version row (migration 080) so the Designs tab can label each
    // version Inventory or New. Per-version, because one design can hold both: v1 quoted
    // from the lot building, v2 a fresh custom build for the same customer.
    const { data: newest } = await admin.from("design_versions")
      .select("id").eq("client_id", clientId).eq("short_code", shortCode)
      .order("version", { ascending: false }).limit(1).maybeSingle();
    let versionStamped = false;
    if (newest) {
      const { error: vErr } = await admin.from("design_versions")
        .update({ inventory_unit_id: unitId }).eq("id", newest.id);
      versionStamped = !vErr;
    }

    // Audited because this was the ONE inventory write that left no trace, and the two
    // columns it sets are the only link between a customer estimate and the building it
    // was quoted from. An untie (unitId null) is invisible by nature — it removes the very
    // evidence that a link existed — so without this row a designs/design_versions
    // disagreement is unattributable after the fact. Not hypothetical: on 2026-08-03 a
    // design was found with BOTH versions pointing at a unit while its
    // designs.inventory_unit_id was null, so list_inventory reported that building with
    // zero estimates and invEffStatus could never derive Sold from it — and nothing
    // recorded what had done it. The version outcome is logged for the same reason: a
    // stamped-versions / null-design split is exactly that shape, and it is silent
    // otherwise. Best-effort like its save_inventory / update_inventory neighbours — the
    // estimate is already submitted and linked here, so a logging blip must not fail it.
    await audit("portal_link_design_to_unit", (count ?? 0) + (versionStamped ? 1 : 0),
      `code=${shortCode} unit=${unitId ?? "none (untied)"} version=${versionStamped ? (newest?.id ?? "") : "not stamped"}`);
    return json({ ok: true, unitId });
  }

  // ── Contact activity timeline (Contacts tab "Details"): everything we know about
  // one contact's designs — version history (what they changed) + GHL estimate events
  // (sent / viewed / accepted / invoiced). Read-only; any linked account may call it
  // (same posture as sync-design-status: tenant-scoped reads, no settings exposure).
  // ── CRM RECORD PAGE ────────────────────────────────────────────────────────────────
  // ONE action serves both contexts, because Carolyn's whole ask was that they are the
  // same screen: "the view of being in an opportunity and the view of being in a person
  // are different, but they're the same. You get the same look, the same work."
  //
  // ⚠️ The page must get ALL of its data from here and never from a direct sb.from() in
  // the browser. designs/payments RLS is scoped to current_client_id(), so in operator
  // view-as a direct read returns NOTHING — which is exactly why DesignsTable and
  // LeadsTable already take a fetchDesigns prop wired to operator-portal. Going through
  // this action means resolveTenant handles targetClientId and app_operators for free.
  if (action === "crm_record") {
    const kind = payload.kind === "design" ? "design" : "contact";
    const id = String(payload.id ?? "").slice(0, 64);
    if (!id) return json({ error: "A record id is required." }, 400);

    // ── CONTACT SCOPE ─────────────────────────────────────────────────────────────────
    // This action serves two records through one gate (see GATES.crm_record), and the gate
    // can only ask the looser of the two questions. Everything hanging off the PERSON — the
    // crm_contacts row, their notes, their email and text threads, the files they sent, the
    // signed URLs for those files — belongs to `contacts`, and this is where that is
    // enforced. Two holders reach here without it:
    //   * a designs-only title (the Crew Leader preset is designs:'view', contacts absent),
    //     which satisfies the `any` gate on the designs half;
    //   * a tenant without the CRM subscription, through the kind='design' entitlement
    //     exemption above — which exists for the DESIGN, not for the CRM behind it.
    const mayReadContacts = canRead("contacts") && crmPaid;
    // A contact record IS the contact half. Nothing of it is theirs to see, so refuse the
    // whole record rather than return an empty one.
    if (kind === "contact" && !mayReadContacts) {
      return json({
        error: canRead("contacts")
          ? "The built-in CRM is not part of your subscription - add it under Settings -> Billing."
          : "Your access does not include Contacts. Ask an owner or admin.",
      }, 403);
    }

    let contact: any = null;
    let codes: string[] = [];
    let designs: any[] = [];

    // ── ROW SCOPE (migration 193) ──────────────────────────────────────────────────────
    // A caller on contacts:'own' may open only the customers they own or follow, and only
    // the designs of those customers. Checked HERE and not by RLS, because this function is
    // service-role and therefore BYPASSRLS — see the ownContacts block at the top.
    //
    // ⚠️ THE REFUSAL IS THE EXISTING 404, WORD FOR WORD, and that is deliberate. Carolyn's
    // rule is "they can't see anything of it" — a distinct "that customer belongs to another
    // rep" would confirm the customer exists, which is a thing about another rep's pipeline
    // and is exactly what the builder asked us to stop leaking. The record page is reached
    // by clicking a list this same rule has already filtered, so the honest 403 would only
    // ever be produced by a stale tab or a hand-typed id.
    if (kind === "contact") {
      const { data: c } = await admin.from("crm_contacts").select("*").eq("client_id", clientId).eq("id", id).maybeSingle();
      if (!c) return json({ error: "That contact no longer exists." }, 404);
      const seen = await visibleContactIds([c.id]);
      if (!seen) return dbFail(req, clientId, "check who this customer is assigned to", { message: "contact scope unavailable" });
      if (!seen.has(c.id)) return json({ error: "That contact no longer exists." }, 404);
      contact = c;
      const { data: ds } = await admin.from("designs")
        // ss_invoice_sent_at drives whether the record page draws the Build and Delivery
        // rails (Carolyn 2026-09-02: "can we make this like hide this if it doesn't have an
        // invoice?"). ⚠️ It is HALF the answer, not the whole one — see the note on the
        // design branch below.
        // ss_invoice_requested_at (229): a customer accepted and the invoice is waiting on the
        // builder. ⚠️ Needs the column — apply migration 229 before deploying this select.
        .select("short_code, created_at, updated_at, status, selections, expected_close_date, total_cents, ghl_estimate_number, image_url, ss_quote_number, ss_quote_pdf_url, ss_invoice_sent_at, ss_invoice_requested_at")
        .eq("client_id", clientId).eq("contact_id", id).order("created_at", { ascending: false });
      designs = ds ?? [];
      codes = designs.map((d: any) => d.short_code);
    } else {
      const { data: d } = await admin.from("designs")
        // ⚠️ ss_invoice_sent_at IS NOT ON ITS OWN A TEST FOR "HAS AN INVOICE", and the
        // browser must not treat it as one. It has exactly ONE writer in this repo —
        // send_invoice, below — so it marks a StructureStudio-issued invoice and nothing
        // else. sync-design-status, which is what flips a GHL-quoted design to 'invoiced',
        // writes {status, updated_at} and never touches this column; migration 136's
        // backfill was narrowed to issued_by='structurestudio' for the same reason. So a
        // design invoiced in GoHighLevel has this NULL forever, and on live that is 14 of
        // junior-barns' buildings — every one of them physically on the build board.
        //
        // The pair is what answers the question: this column catches an SS invoice that is
        // OUT BUT UNSIGNED (a state `status` cannot express, because send_invoice
        // deliberately stopped flipping it), and `status` catches the GHL path. Neither
        // half is redundant. crmHasInvoice in portal/02-sales.jsx is the union.
        .select("short_code, created_at, updated_at, status, selections, expected_close_date, total_cents, contact, contact_id, ghl_estimate_number, image_url, ss_quote_number, ss_quote_pdf_url, ss_invoice_sent_at, ss_invoice_requested_at")
        .eq("client_id", clientId).eq("short_code", id).maybeSingle();
      if (!d) return json({ error: "That design no longer exists." }, 404);
      // The design branch of the same rule. A design with contact_id NULL is refused here
      // for everyone on 'own' — edge case 2: crm_ensure_contact returned NULL because the
      // submission carried neither a phone nor an email, so there is no customer to own it.
      const seen = await visibleDesignRows([d]);
      if (!seen) return dbFail(req, clientId, "check who this customer is assigned to", { message: "contact scope unavailable" });
      if (!seen.length) return json({ error: "That design no longer exists." }, 404);
      designs = [d];
      codes = [d.short_code];
      // The CRM record for the person behind this design — only for someone entitled to the
      // contact half. Withheld, the design still opens: the fallback below rebuilds the
      // Person panel from the design's OWN snapshot, which is the same name/phone/email the
      // designs row has always carried and which whoever may read the design may read.
      if (d.contact_id && mayReadContacts) {
        const { data: c } = await admin.from("crm_contacts").select("*").eq("client_id", clientId).eq("id", d.contact_id).maybeSingle();
        contact = c ?? null;
      }
      // Fall back to the jsonb blob for a design predating the backfill, so the Person
      // panel is never empty on an old record. It is also what a contacts-less caller gets:
      // `id: null` is what carries the narrowing downward — the feed, the focus list and the
      // consent lookup below all key off contact.id, so every contact-scoped read collapses
      // to the design's own codes without a second condition to keep in step.
      if (!contact && d.contact) contact = { id: null, name: d.contact.name, phone: d.contact.phone, email: d.contact.email };
    }

    // ── EIGHT READS, ONE WAIT ──────────────────────────────────────────────────────────
    // Ahsan, 2026-09-20: "it takes too much time to open this." Measured on beta before this
    // change, against a WARM isolate (so this is not the cold-start cost documented
    // elsewhere): crm_record took 3.8s, 4.3s and 5.4s on three consecutive opens of the same
    // contact, and 7.5s on the first one after a page load. The record page makes exactly one
    // call — the comments below each say why, and that is still right — but that one call was
    // running its reads ONE AFTER ANOTHER: feed, then focus, then orders, then build, then
    // delivery, then repairs, then the SMS config, then the people. Roughly thirteen
    // round-trips end to end, each waiting on a result the next one never looks at.
    //
    // ⚠️ THEY ARE INDEPENDENT AND THE ORDER NEVER MATTERED. Everything any of them needs —
    // `contact`, `designs`, `codes` — is already resolved above, which is why the sequential
    // version read the same in any order. The only two real dependencies stay sequential
    // INSIDE their own branch: delivery's stops→loads, and people/followers→roster.
    //
    // ⚠️ NOTHING HERE MAY MUTATE `contact`. The owner-name merge used to happen inside the
    // people block; concurrently with the SMS branch, which reads contact.phone_digits and
    // contact.sms_opt_out_at, that would be a read of an object another branch is replacing.
    // The name comes back as a value and is merged AFTER the wait, below.
    //
    // Every branch keeps its own error handling exactly as it was, including the
    // absent-vs-empty distinction three of them have a comment about: Promise.all rejects on
    // the first THROW, and none of these throws — a failed read comes back on `.error` and is
    // turned into `undefined` by the same line that always did it.
    const [feed, focusRows, ordersOut, buildOut, delivery, repairs, sms, peopleOut] = await Promise.all([
      buildCrmFeed(admin, clientId, { codes, contactId: contact?.id ?? null, isAdmin: true }),
      // Focus = open activities, soonest first. This is the crm_activities_focus index.
      admin.from("crm_activities")
        .select("id, kind, subject, due_at, assignee_user_id, short_code")
        .eq("client_id", clientId).eq("done", false)
        .or(contact?.id ? `contact_id.eq.${contact.id}` : `short_code.in.(${codes.join(",") || "''"})`)
        .order("due_at", { ascending: true, nullsFirst: false }).limit(25)
        .then(({ data }: any) => data),

      // ORDERS ON THE RECORD. Carolyn, 2026-08-26 33:20: "when you're in contacts, in a
      // contact, I feel like you should see the deal. You should see the orders."
      //
      // The deal half already existed (the designs/person reciprocal embed); this is the half
      // that was missing, and it is the one that answers "have they actually bought anything".
      // Joined on short_code because orders.short_code is a soft link with no FK for PostgREST
      // to embed — the same reason OrdersView reads them separately.
      //
      // It rides THIS fetch rather than adding a second round-trip from the browser: the
      // record page makes exactly one call on purpose, because designs/orders RLS is scoped to
      // current_client_id() and a direct read returns nothing in operator view-as.
      // orders has NO `status` column -- verified against live 2026-08-29 (information_schema:
      // id, client_id, short_code, order_no, total_cents, currency, total_source, ordered_at,
      // notes, created_at, updated_at, submitter_user_id, pretax_subtotal_cents, tax_cents).
      // Asking for it made PostgREST answer 42703 on EVERY call, for every tenant, since this
      // block shipped -- and because only `data` was destructured, the error was dropped and
      // `orders` fell to [], which the card renders as "No orders yet." on contacts holding
      // real orders. There are 43 of them across three tenants. The status shown on the Orders
      // TAB is derived from payments client-side, not stored, so nothing here needs it.
      (async () => {
        let orders: any[] | undefined = [];
        if (codes.length) {
          const { data: os, error: oe } = await admin.from("orders")
            .select("id, order_no, short_code, total_cents, ordered_at")
            .eq("client_id", clientId).in("short_code", codes)
            .order("ordered_at", { ascending: false }).limit(50);
          // A FAILED READ IS NOT AN EMPTY ONE. Leaving it undefined makes the card say "Orders
          // appear here once the server update lands" -- the absent state the section already
          // has -- instead of stating that a customer who has bought two buildings bought none.
          // That distinction is written into the card's own comment; swallowing the error is
          // exactly what defeated it.
          orders = oe ? undefined : (os ?? []);
        }
        return orders;
      })(),
      // ── BUILD, DELIVERY AND REPAIRS ON THE RECORD ──────────────────────────────────────
      // Carolyn, 2026-08-28 @37:48: "whether you're in a contact or whether you're in a deal,
      // it doesn't matter, you want to be able to see the contact details, the deals, the
      // orders, the build schedule, the delivery schedule ... Repairs also."
      //
      // ⚠️ READ-ONLY, AND THEY STAY THEIR OWN SYSTEMS. She was explicit at @23:40 that build
      // and delivery must NOT become pipelines: "I don't really want to change this and make
      // it a pipeline because I've got a lot of work in both of these." So this reads
      // schedule_stages / delivery_loads where they live; it does not mirror or re-model them.
      //
      // Gated per area, not on the CRM gate: a sales rep can hold contacts:view and no
      // build_schedule:view at all, and the card must then be ABSENT rather than empty --
      // undefined here means "not yours to see", [] means "nothing scheduled". The frontend
      // renders those two differently, which is the same absent-vs-empty distinction the
      // orders block above exists to protect.
      //
      // Rides this fetch rather than adding round-trips: the record page makes exactly one
      // call on purpose, because a direct browser read returns nothing in operator view-as.
      (async () => {
        let build: any[] | undefined;
        let stages: any[] | undefined;
        if (canRead("build_schedule")) {
          const [jobsRes, stRes] = await Promise.all([
            codes.length
              ? admin.from("build_jobs")
                  .select("id, design_short_code, stage_id, due_date, completed_at, serial, source, crew_id")
                  .eq("client_id", clientId).in("design_short_code", codes).limit(50)
              : Promise.resolve({ data: [], error: null }),
            // The ladder itself, because stage names are TENANT-EDITABLE. The dot bar has to
            // draw the stages this builder actually uses, and automation keys on `kind`, never
            // on the name -- the Monday label-rename lesson, which this table already carries.
            admin.from("schedule_stages")
              .select("id, name, kind, sort_order, color")
              .eq("client_id", clientId).eq("archived", false).order("sort_order"),
          ]);
          build = jobsRes.error ? undefined : (jobsRes.data ?? []);
          stages = stRes.error ? undefined : (stRes.data ?? []);
        }
        return { build, stages };
      })(),

      (async () => {
        let delivery: any[] | undefined;
        if (canRead("delivery_schedule")) {
      // Stops carry the building; the LOAD carries the status. There is no delivery stages
      // table -- it is a fixed planned|out|delivered CHECK on delivery_loads -- so the dot
      // bar's delivery row is that ladder, not a configurable one.
      //
          // Two reads and a join in JS rather than a PostgREST embed: an embed silently returns
          // nothing when the FK it needs is not where the resolver expects, and a delivery card
          // that is quietly always empty is the exact failure this endpoint just had with
          // orders.status. Two explicit reads cannot fail that way.
          //
          // ⚠️ THE ONE PAIR HERE THAT REALLY IS SEQUENTIAL: the load ids come out of the stops,
          // so this branch keeps its two round-trips. It just no longer holds up the other six.
          const stopsRes = codes.length
            ? await admin.from("delivery_stops")
                .select("id, design_short_code, delivered_at, load_id, stop_order")
                .eq("client_id", clientId).in("design_short_code", codes).limit(50)
            : { data: [], error: null };
          if (stopsRes.error) {
            delivery = undefined;
          } else {
            const stops = stopsRes.data ?? [];
            const loadIds = [...new Set(stops.map((s: any) => s.load_id).filter(Boolean))];
            const loadsRes = loadIds.length
              ? await admin.from("delivery_loads")
                  .select("id, load_no, status, load_date, departed_at, completed_at")
                  .eq("client_id", clientId).in("id", loadIds)
              : { data: [], error: null };
            const byId = new Map((loadsRes.data ?? []).map((l: any) => [l.id, l]));
            delivery = stops.map((s: any) => ({ ...s, load: byId.get(s.load_id) ?? null }));
          }
        }
        return delivery;
      })(),

      (async () => {
        let repairs: any[] | undefined;
        if (canRead("repairs")) {
          // ⚠️ REPAIRS DO NOT LINK TO crm_contacts. There is no contact_id on the table -- they
          // key on design_short_code (plus a denormalised name/phone/email captured at intake),
          // which is why this joins on `codes` like every other section here rather than on the
          // contact. Checked against live before writing it; the obvious .eq("contact_id", ...)
          // would have returned nothing forever and rendered as "no repairs".
          const rr = codes.length
            ? await admin.from("repairs")
                .select("id, repair_no, status, description, design_short_code, requested_at, completed_at, quote_cents")
                .eq("client_id", clientId).in("design_short_code", codes)
                .order("requested_at", { ascending: false }).limit(50)
            : { data: [], error: null };
          repairs = rr.error ? undefined : (rr.data ?? []);
        }
        return repairs;
      })(),

      // Whether this tenant can text at all, so the SMS tab can give the RIGHT reason when
      // it is disabled. Three different things stop a text going out — no permission, no
      // number on the contact, no registered number on the account — and one flat "not
      // available" sends people off editing a contact that is fine. Same lesson the Email
      // tab's hint already carries.
      (async () => {
        // The config and the consent grant do NOT depend on each other, so they go together
        // rather than one after the other — the same reason this whole block is a Promise.all.
        const [cfgRes, grantRes] = await Promise.all([
          admin.from("client_settings")
            .select("sms_number, sms_status").eq("client_id", clientId).maybeSingle(),
          contact && contact.phone_digits
            ? admin.from("sms_consent_log")
                .select("action").eq("client_id", clientId)
                .eq("phone_digits", contact.phone_digits).eq("action", "granted")
                .limit(1).maybeSingle()
            : Promise.resolve({ data: null, error: null }),
        ]);
        const smsCfg = cfgRes.data;
        return {
          ready: !!(smsCfg && smsCfg.sms_status === "active" && smsCfg.sms_number),
          // The tenant's own number, shown in the composer so a rep knows which number the
          // customer will see. Never the platform's, and never another tenant's.
          from: (smsCfg && smsCfg.sms_status === "active") ? (smsCfg.sms_number ?? null) : null,
          optedOut: !!(contact && contact.sms_opt_out_at),
          // ⚠️ CONSENT IS NOW REQUIRED TO SEND, so the composer has to be able to SHOW its absence
          // rather than let someone type a message and discover it on Send. Asked as "is there a
          // grant?" — the same question smsSend asks, deliberately, so the screen and the send path
          // cannot disagree about who is textable. Revocation is the opt-out above; these are two
          // separate facts and the UI shows the right sentence for each.
          //
          // ⚠️ The `phone_digits` test still guards the ANSWER, not just the query: a contact
          // with no number is not consented no matter what the register happens to hold.
          consented: !!(contact && contact.phone_digits) && !!grantRes.data,
        };
      })(),

      // ── THE OTHER PEOPLE ON THE RECORD, AND WHO IS WATCHING IT ─────────────────────────
      // Carolyn, 2026-09-04 ~1:13:00: "This is name one and then the wife and then the phone
      // number … it doesn't have to be husband and wife, it can be two people buying, two
      // business partners" — each with their own phone and email (migration 190). And at
      // 1:09:30: "we do not ever assign deals. We only assign contacts and followers"
      // (migration 189).
      //
      // Contact-scoped, because both hang off the PERSON: a design record shows them once its
      // contact has been resolved, and shows nothing when it has not. They ride this fetch for
      // the reason everything else here does — the record page makes exactly one call, since a
      // direct browser read returns nothing in operator view-as.
      //
      // undefined on a failed read, [] on an empty one. Same distinction the orders block above
      // exists to protect, and it matters more here than usual: until the migrations are
      // applied these two tables do not exist, and "nobody is following this customer" is a
      // very different sentence from "we could not ask".
      (async () => {
        let people: any[] | undefined;
        let followers: any[] | undefined;
        // The tenant's roster, for the owner picker. `undefined` on a contact record we never
        // built it for, following this file's absent-vs-empty rule: [] would tell the browser
        // "this tenant has no team", which is never true and would hide the picker for good.
        let team: any[] | undefined;
        // The owner's NAME comes back as a value rather than being merged onto `contact` here.
        // Two other branches of this Promise.all read that object while this one runs.
        let ownerName: string | null = null;
        if (contact?.id) {
          const [pplRes, folRes, rosterRes] = await Promise.all([
            admin.from("crm_contact_people")
              .select("id, ordinal, name, phone, email, is_primary, source, created_at")
              .eq("client_id", clientId).eq("contact_id", contact.id)
              .order("ordinal", { ascending: true }).order("created_at", { ascending: true }).limit(25),
            admin.from("crm_contact_followers")
              .select("id, user_id, added_at, added_reason")
              .eq("client_id", clientId).eq("contact_id", contact.id)
              .order("added_at", { ascending: true }).limit(50),
            // A uuid is not a person. Resolved here rather than left to the browser, which has no
            // way to ask: client_users' only policy is client_users_select_own, so a portal user
            // cannot read their own colleagues' rows — a follower list rendered client-side would
            // be a column of ids. The owner is resolved in the same pass, because the record page
            // needs the assignee's name beside the same faces.
            //
            // THE WHOLE TEAM comes back, not only the ids in use, because the record page has to
            // offer an OWNER PICKER and the same policy that stops the browser naming a follower
            // stops it listing candidates: without this the picker would be an empty drop-down on
            // a screen that is already showing the current owner's name, which reads as broken
            // rather than as unauthorised. One read serves both — resolving the ids in use out of
            // the roster costs nothing extra, so this REPLACES the previous `.in("user_id", …)`
            // lookup rather than adding a second round trip.
            //
            // ⚠️ It rides the SAME Promise.all as the two reads above now. It never depended on
            // them — the roster is the whole tenant, not the ids they happen to mention — so
            // waiting for them bought nothing and cost a round-trip.
            //
            // ⚠️ Capped, and ordered by name so the cap is stable rather than arbitrary. A tenant
            // with more people than this needs a search field, not a longer list — and a silently
            // truncated picker that happens to omit the person you want is worse than one that
            // does not pretend to be complete.
            admin.from("client_users")
              .select("user_id, full_name, title").eq("client_id", clientId)
              .order("full_name", { ascending: true }).limit(200),
          ]);
          people = pplRes.error ? undefined : (pplRes.data ?? []);
          followers = folRes.error ? undefined : (folRes.data ?? []);
          const roster = rosterRes.data;
          const byId = new Map((roster ?? []).map((u: any) => [u.user_id, u.full_name ?? null]));
          if (followers) followers = followers.map((f: any) => ({ ...f, name: byId.get(f.user_id) ?? null }));
          ownerName = contact.owner_user_id ? (byId.get(contact.owner_user_id) ?? null) : null;
          team = (roster ?? []).map((u: any) => ({ userId: u.user_id, name: u.full_name ?? null, title: u.title ?? null }));
        }
        return { people, followers, team, ownerName };
      })(),
    ]);

    // Unpacked after the wait, and `contact` is merged HERE rather than inside a branch —
    // see the warning on the Promise.all above.
    const { build, stages } = buildOut;
    const { people, followers, team, ownerName } = peopleOut;
    const orders = ordersOut;
    if (contact?.id) contact = { ...contact, owner_name: ownerName };

    // Customer uploads are NOT returned separately any more. They ride the FEED, alongside
    // the documents we generate, because Carolyn asked for exactly one place: "the top part
    // is about things to do. The bottom part is about history … instead of in two places."
    // crmFeed signs their URLs; keeping a second copy here would be the second access path
    // this file exists to avoid.
    return json({ ok: true, kind, contact, designs, orders, feed, focus: focusRows ?? [], sms, build, stages, delivery, repairs, people, followers, team });
  }

  if (action === "crm_feed") {
    const rawCodes = Array.isArray(payload.codes) ? payload.codes.map((c: unknown) => String(c).slice(0, 32)).slice(0, 200) : [];
    // ── TWO SCOPES, LAYERED. They arrived from two sessions the same night and they are not
    // alternatives — they narrow along different axes, and taking either alone leaves a hole.
    //
    // AREA SCOPE first: this action's `any` gate is satisfied by designs:view, and
    // `contactId` is what widens the feed from "these designs" to "this person's whole
    // history" — their notes, both mail directions, both text directions and the files they
    // uploaded. Somebody with no contacts access at all must not get that by asking here.
    // Ignored rather than refused: the designs half of the request is legitimate and still
    // answers, and the caller's own record page already hides the person's card.
    const rawContactId = (payload.contactId && canRead("contacts")) ? String(payload.contactId).slice(0, 64) : null;
    // ROW SCOPE second (migration 193): and of the customers they CAN see, only the ones
    // assigned to or followed by them. BOTH inputs come straight from the browser and both
    // address other people's rows, so both are narrowed. This is the action that would
    // otherwise stay wide open after crm_record was fixed — the record page fetches its feed
    // separately, so a caller on contacts:'own' could post any short code or any contact id
    // here and read that customer's whole record, just without its header.
    //
    // A contact that is not theirs is DROPPED rather than refused, and the feed is built from
    // whatever survives (nothing, usually). Refusing outright would make this endpoint an
    // existence oracle for contact ids, which is the same leak in a different shape.
    const codes = await visibleShortCodes(rawCodes);
    if (!codes) return dbFail(req, clientId, "check who these customers are assigned to", { message: "contact scope unavailable" });
    const seen = await visibleContactIds([rawContactId]);
    if (!seen) return dbFail(req, clientId, "check who this customer is assigned to", { message: "contact scope unavailable" });
    const contactId = rawContactId && seen.has(rawContactId) ? rawContactId : null;
    const feed = await buildCrmFeed(admin, clientId, { codes, contactId, isAdmin: true });
    return json({ ok: true, feed });
  }

  // ── EMAIL A CUSTOMER FROM THE RECORD PAGE ──────────────────────────────────────────
  // Email IS the conversation channel here. Ahsan, 2026-08-25: "we are using the emails for
  // the conversation now and messaging." Carolyn, 2026-08-21, having ruled out duplicating
  // GoHighLevel: "conversations would be email, all of it."
  //
  // Everything email_sends held until now was a DOCUMENT — an estimate, an invoice, an
  // acceptance receipt, each generated by a pipeline. This is a person writing to a person,
  // which is what turns the Emails chip on the record page from a receipt log into a
  // conversation.
  // ── CUSTOMER UPLOADS ────────────────────────────────────────────────────────────────
  // The files a customer SENDS, kept apart from the documents we generate. Carolyn,
  // 2026-08-26: "I don't want it all mixed together."
  //
  // Three actions, because the bytes must not travel through this function: sign an upload,
  // then record what landed. A 25 MB base64 body would blow the request limit and burn the
  // memory of a function that also serves every settings screen — the existing base64 upload
  // actions cap at 3 MB for exactly that reason, which is too small for a permit scan.
  //
  // ⚠️ THE BUCKET HAS NO STORAGE POLICIES. That is deliberate and documented in migration
  // 151: a tenant-prefix policy reads `current_client_id()`, which is the OPERATOR's tenant
  // in view-as, so direct browser uploads would work for owners and 403 for operators. Here,
  // `clientId` is whatever resolveTenant resolved — the viewed tenant — and the service role
  // does the work.
  const STORAGE_DEFAULT_QUOTA = 2 * 1024 * 1024 * 1024;   // 2 GB per tenant
  const STORAGE_MAX_FILE = 25 * 1024 * 1024;              // matches the bucket's file_size_limit

  if (action === "crm_file_sign") {
    const contactId = payload.contactId ? String(payload.contactId).slice(0, 64) : null;
    if (!contactId) return json({ error: "A file has to attach to a contact." }, 400);
    // ⚠️ THE CONTACT HAS TO EXIST BEFORE THE URL IS SIGNED. `contactId` goes straight into
    // the storage path, and any string used to make one: the bytes landed in the bucket, and
    // then crm_file_attach's foreign key refused the ledger row — leaving an object nothing
    // in the product can see, that no quota counts and that nobody can delete from a screen.
    // This is the same check that FK performs, moved to where it prevents the orphan instead
    // of stranding it. Tenant-scoped, so a real id belonging to another account fails it too.
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(contactId)) {
      return json({ error: "That file does not belong to this contact." }, 400);
    }
    {
      const { data: who, error: whoErr } = await admin.from("crm_contacts")
        .select("id").eq("client_id", clientId).eq("id", contactId).maybeSingle();
      if (whoErr) return dbFail(req, clientId, "look up that contact", whoErr);
      if (!who) return json({ error: "That file does not belong to this contact." }, 400);
    }
    const rawName = String(payload.name ?? "").trim().slice(0, 200);
    if (!rawName) return json({ error: "That file has no name." }, 400);
    const size = Number(payload.size);
    if (!Number.isFinite(size) || size <= 0) return json({ error: "That file looks empty." }, 400);
    if (size > STORAGE_MAX_FILE) {
      return json({ error: `"${rawName}" is larger than 25 MB, which is the most we can take in one file.` }, 400);
    }

    // ── The quota, checked BEFORE the URL is signed ─────────────────────────────────
    // Carolyn asked for this in the same breath as the feature ("we just need to cap what
    // their storage limits are"), and a cap enforced after the upload is not a cap.
    const { data: cs } = await admin.from("client_settings")
      .select("storage_quota_bytes").eq("client_id", clientId).maybeSingle();
    const quota = (cs && Number(cs.storage_quota_bytes)) || STORAGE_DEFAULT_QUOTA;
    const { data: used, error: uErr } = await admin.from("crm_files")
      .select("size_bytes").eq("client_id", clientId).is("deleted_at", null);
    if (uErr) return dbFail(req, clientId, "check this account's file storage", uErr);
    const usedBytes = (used ?? []).reduce((n: number, r: any) => n + Number(r.size_bytes || 0), 0);
    if (usedBytes + size > quota) {
      const gb = (quota / (1024 * 1024 * 1024)).toFixed(1);
      return json({
        error: `This account's file storage is full (${gb} GB). Delete some customer uploads, or ask CSM Synergy to raise the limit.`,
        reason: "quota",
      }, 409);
    }

    // The path carries the tenant and the contact so an operator reading the bucket can tell
    // whose file it is without a database round trip. The uuid prefix keeps two customers
    // sending "photo.jpg" from colliding, and the name is sanitized because it lands in a URL.
    const safe = rawName.replace(/[^\w.\- ]+/g, "_").slice(-80);
    const path = `${clientId}/${contactId}/${crypto.randomUUID().slice(0, 8)}-${safe}`;
    const { data: signed, error } = await admin.storage.from("customer-uploads").createSignedUploadUrl(path);
    if (error) return dbFail(req, clientId, "start that upload", error);
    return json({ ok: true, path, token: signed?.token, signedUrl: signed?.signedUrl });
  }

  // ── THE CONTACT AND THE DEAL MUST BE THE SAME CUSTOMER'S ───────────────────────────
  // Returns a refusal Response, or null to carry on.
  //
  // WHY THIS ONLY MATTERS NOW. Until the record page grew a deal picker (Carolyn
  // 2026-09-02: "you have to select a deal, or an order, in order for anything to show up
  // here, so you know what you're talking about"), a contact-scoped write ALWAYS sent
  // shortCode: null — the two ids were never both present, so there was no pair to
  // disagree. Now every note, activity, text, email and upload made from a contact record
  // carries the deal it is about, and a wrong code would file a note about customer A onto
  // customer B's deal: a cross-record leak inside one tenant, visible in the other
  // customer's history.
  //
  // It is deliberately NOT a requirement that a shortCode be present. Migration 131's own
  // CHECK is "contact_id OR short_code", other callers legitimately send one or the other,
  // and crm_save_note's edit path sends neither. Requiring one here would refuse writes
  // that are correct. The rule is only: if you send both, they must agree.
  //
  // 400 rather than text_sign_link's 409 — that one means "the state is wrong", this means
  // "these two arguments contradict each other".
  const mismatchedPair = async (
    contactId: string | null,
    shortCode: string | null,
  ): Promise<Response | null> => {
    if (!contactId || !shortCode) return null;
    const { data, error } = await admin.from("designs").select("short_code")
      .eq("client_id", clientId).eq("short_code", shortCode).eq("contact_id", contactId).maybeSingle();
    if (error) return dbFail(req, clientId, "check that deal", error);
    if (!data) return json({ error: "That deal doesn't belong to this contact." }, 400);
    return null;
  };

  if (action === "crm_file_attach") {
    const contactId = payload.contactId ? String(payload.contactId).slice(0, 64) : null;
    const path = String(payload.path ?? "");
    // ⚠️ RE-CHECK THE PATH. The browser was handed a signed URL for one path and could send
    // a different one here, which would file somebody else's object onto this contact.
    if (!contactId || !path.startsWith(`${clientId}/${contactId}/`)) {
      return json({ error: "That file does not belong to this contact." }, 400);
    }
    const attachCode = payload.shortCode ? String(payload.shortCode).slice(0, 32) : null;
    { const bad = await mismatchedPair(contactId, attachCode); if (bad) return bad; }

    // ── THE SIZE IS THE BUCKET'S ANSWER, NOT THE BROWSER'S ────────────────────────────
    // crm_files.size_bytes is the whole storage ledger: crm_file_sign sums it to decide
    // whether a tenant is over quota. Until now it was whatever the caller declared, and the
    // caller is the party the cap applies to — a understated number let an account keep
    // uploading long past its limit, and an overstated one locked a tenant out of storage
    // they were not using. Reading the object back closes both: the bucket's own 25 MB and
    // mime limits (migration 151) still refuse the upload itself, and what we RECORD is now
    // what actually landed.
    //
    // It doubles as the completion check. `list` finding nothing means the signed URL was
    // never used, so there is no file to file — refuse rather than write a ledger row (and a
    // feed entry, and a quota charge) for an object that does not exist.
    const basename = path.slice(path.lastIndexOf("/") + 1);
    const { data: objs, error: lsErr } = await admin.storage.from("customer-uploads")
      .list(`${clientId}/${contactId}`, { search: basename, limit: 100 });
    if (lsErr) return dbFail(req, clientId, "check that upload", lsErr);
    // deno-lint-ignore no-explicit-any
    const obj = (objs ?? []).find((o: any) => o?.name === basename);
    if (!obj) {
      return json({ error: "That upload didn't finish — send the file again." }, 409);
    }
    // deno-lint-ignore no-explicit-any
    const realSize = Number((obj as any)?.metadata?.size);
    const row = {
      client_id: clientId,
      contact_id: contactId,
      short_code: attachCode,
      path,
      name: String(payload.name ?? "file").trim().slice(0, 200),
      // The declared size stays only as the fallback for a provider that returned no
      // metadata — never as the preferred answer.
      size_bytes: Number.isFinite(realSize) && realSize >= 0
        ? Math.round(realSize)
        : Math.max(0, Math.min(Number(payload.size) || 0, STORAGE_MAX_FILE)),
      mime: payload.mime ? String(payload.mime).slice(0, 100) : null,
      uploaded_by: userId ?? null,
    };
    const { error } = await admin.from("crm_files").insert(row);
    if (error) return dbFail(req, clientId, "record that upload", error);
    return json({ ok: true });
  }

  if (action === "crm_file_delete") {
    const id = String(payload.id ?? "").slice(0, 64);
    if (!id) return json({ error: "Which file?" }, 400);
    const { data: f } = await admin.from("crm_files")
      .select("id, path").eq("client_id", clientId).eq("id", id).maybeSingle();
    if (!f) return json({ error: "That file is already gone." }, 404);
    // Storage first, then the row. The other order can leave a row pointing at nothing,
    // which renders as a broken download; this order can at worst leave an orphaned object,
    // which nobody sees and which the quota stops counting either way.
    const { error: rmErr } = await admin.storage.from("customer-uploads").remove([f.path]);
    if (rmErr) return dbFail(req, clientId, "delete that file", rmErr);
    const { error } = await admin.from("crm_files")
      .update({ deleted_at: new Date().toISOString() }).eq("client_id", clientId).eq("id", id);
    if (error) return dbFail(req, clientId, "delete that file", error);
    return json({ ok: true });
  }

  // ── TEXT A CUSTOMER FROM THE RECORD PAGE ───────────────────────────────────────────
  // Carolyn, 2026-08-26 27:02, walking the action bar: "and we have calls. We probably need
  // SMS in there, too. We will need that in there as well."
  //
  // ⚠️ THE BROWSER SENDS IDS, NEVER A PHONE NUMBER. The number is read from crm_contacts
  // server-side and normalized there (see smsSend). A number in the request body would be
  // an open relay: anyone with a portal login could text any handset from the tenant's
  // registered number, on the shared A2P campaign every other builder depends on.
  // ── text_sign_link: put the signing link on the customer's own phone ───────────────
  //
  // Carolyn 2026-09-01: "when we are sitting with a customer we want to be able to send
  // them a text message and they click on the link, for them to sign on their phone."
  //
  // Re-delivery ONLY. It mints no invoice, allocates no number and changes no state — the
  // worst case is a duplicate text to the design's own customer, which is why it is safe
  // at orders/edit. The link carries `?q=<short_code>`, which my-quotes.html reads to land
  // them on this invoice; it grants nothing on its own, because signing still needs the
  // texted code and customer-quotes only returns designs matching that verified phone.
  //
  // ⚠️ SAME RULE AS crm_send_sms: the number is read HERE, from the design's own contact.
  // Accepting one from the browser would be an open relay on the tenant's A2P campaign.
  if (action === "text_sign_link") {
    const shortCode = String(payload?.shortCode ?? "").trim();
    if (!shortCode) return json({ error: "shortCode is required." }, 400);
    // ROW SCOPE (207). A rep on contacts:'own' may hold designs:edit / orders:edit and
    // still not be allowed near THIS customer's building. The gate above decides what
    // KIND of thing they may do; this decides which rows. Placed before the design is
    // even read, so a refusal costs nothing and cannot leak timing.
    { const refused = await refuseUnlessDesignVisible(shortCode); if (refused) return refused; }

    const { data: d, error: dErr } = await admin.from("designs")
      .select("short_code, contact, status, ss_quote_number, ss_invoice_sent_at")
      .eq("client_id", clientId).eq("short_code", shortCode).maybeSingle();
    if (dErr) return dbFail(req, clientId, "find that design", dErr);
    if (!d) return json({ error: "Design not found." }, 404);

    const { data: cs, error: csErr } = await admin.from("client_settings")
      .select("invoice_in_ghl, business_name")
      .eq("client_id", clientId).maybeSingle();
    if (csErr) return dbFail(req, clientId, "read your settings", csErr);
    if (!cs || cs.invoice_in_ghl !== false) {
      return json({ error: "This account invoices through the CRM — send it from there." }, 400);
    }

    // There must be something to sign. Texting "sign your invoice" at someone who has no
    // invoice, or who already signed, is worse than refusing.
    const { data: inv, error: iErr } = await admin.from("invoice_sends")
      .select("invoice_number, status, issued_by, signed_at")
      .eq("client_id", clientId).eq("short_code", shortCode).maybeSingle();
    if (iErr) return dbFail(req, clientId, "load that invoice", iErr);
    if (!inv || inv.issued_by !== "structurestudio" || !["created", "sent"].includes(String(inv.status))) {
      return json({ error: "There's no StructureStudio invoice on this order yet." }, 409);
    }
    if (inv.signed_at) return json({ error: "They've already signed this invoice." }, 409);

    const to = String((d.contact as Record<string, unknown> | null)?.phone ?? "").trim();
    if (!to) return json({ ok: true, sent: false, reason: "no phone number on this design" });

    const link = `${myQuotesUrl(clientId, req)}&q=${encodeURIComponent(shortCode)}`;
    const who = String(cs.business_name || "").trim();
    const body = `${who ? who + ": " : ""}your invoice ${inv.invoice_number ?? ""} is ready to sign. `
      + `Open ${link} and we'll text you a code to confirm it's you.`;

    const secret = Deno.env.get("SMS_INBOUND_SECRET") ?? "";
    const statusCallback = secret
      ? `${Deno.env.get("SUPABASE_URL") ?? ""}/functions/v1/sms-status?key=${encodeURIComponent(secret)}`
      : null;

    const out = await sendTenantSms(admin, clientId, {
      toPhone: to,
      body,
      shortCode,
      sentBy: userId ?? null,
      statusCallback,
      // A rep pressing this with the customer in front of them is not what quiet hours
      // exist to stop — it is the same "a human hitting send" case smsSend documents.
      bypassQuietHours: true,
    });
    if (!out.sent) {
      // `not_active` is the product being off, not a fault: it is where EVERY tenant sits
      // until their A2P campaign clears. The portal turns this into "show them the QR
      // code instead", which is a real answer rather than a dead end.
      return json({
        ok: true, sent: false,
        reason: out.reason === "not_active"
          ? (out.error ?? "texting isn't switched on for this account yet")
          : (out.error ?? "the text could not be sent"),
      });
    }
    return json({ ok: true, sent: true, to, id: out.id, invoiceNumber: inv.invoice_number ?? null });
  }

  if (action === "crm_send_sms") {
    const body = String(payload.body ?? "").trim().slice(0, 1600);
    if (!body) return json({ error: "The message is empty." }, 400);
    const contactId = payload.contactId ? String(payload.contactId).slice(0, 64) : null;
    const shortCode = payload.shortCode ? String(payload.shortCode).slice(0, 32) : null;
    if (!contactId) return json({ error: "A text has to be addressed to a contact." }, 400);
    { const bad = await mismatchedPair(contactId, shortCode); if (bad) return bad; }

    const { data: c, error: cErr } = await admin.from("crm_contacts")
      .select("phone").eq("client_id", clientId).eq("id", contactId).maybeSingle();
    if (cErr) return dbFail(req, clientId, "look up that contact", cErr);
    if (!c || !c.phone) return json({ error: "This contact has no phone number on file." }, 400);

    // Twilio posts delivery receipts back here. Built from SUPABASE_URL so it follows the
    // project rather than being pinned in the console, and carrying the same shared secret
    // the inbound webhook uses.
    const secret = Deno.env.get("SMS_INBOUND_SECRET") ?? "";
    const statusCallback = secret
      ? `${Deno.env.get("SUPABASE_URL") ?? ""}/functions/v1/sms-status?key=${encodeURIComponent(secret)}`
      : null;

    const out = await sendTenantSms(admin, clientId, {
      toPhone: String(c.phone),
      body,
      contactId,
      shortCode,
      sentBy: userId ?? null,
      statusCallback,
    });
    if (!out.sent) {
      // `not_active` is the product being switched off, not a fault — it is the state every
      // tenant is in until the A2P campaign clears, so it must not read as an error. The
      // other reasons carry an authored sentence from smsSend; pass it through verbatim
      // rather than restating it.
      if (out.reason === "not_active") {
        return json({
          error: out.error ?? "Texting isn't switched on for this account yet.",
          reason: "not_active",
        }, 409);
      }
      return json({ error: out.error ?? "The text could not be sent.", reason: out.reason }, 400);
    }
    return json({ ok: true, id: out.id });
  }

  // ── Record permission a customer gave in person ───────────────────────────────────
  // The back catalogue has no consent records — every contact captured before the gate's
  // checkbox existed is unreachable — and the only lawful ways in are the customer ticking
  // the box or texting first. This is the third: a human recording permission actually given.
  //
  // ⚠️ IT IS AN ATTESTATION, NOT A TOGGLE, and the difference is the whole design. Someone is
  // asserting that a specific person agreed to be texted, and that assertion is what would be
  // produced if the claim were ever challenged. So the sentence they agreed to is stored
  // VERBATIM alongside WHO said it — the same rule the designer gate follows. A one-click
  // "enable texting" would manufacture evidence, which is worse than having none.
  if (action === "crm_record_consent") {
    const contactId = payload.contactId ? String(payload.contactId).slice(0, 64) : "";
    if (!contactId) return json({ error: "Which customer?" }, 400);
    const { data: c } = await admin.from("crm_contacts")
      .select("id, phone_digits, sms_opt_out_at")
      .eq("client_id", clientId).eq("id", contactId).maybeSingle();
    if (!c) return json({ error: "That customer could not be found." }, 404);
    if (!c.phone_digits) return json({ error: "This customer has no phone number on file." }, 400);

    // ⛔ AN OPT-OUT OUTRANKS THIS, ALWAYS. Someone who replied STOP cannot be put back by a
    // colleague ticking a box — only they can, by replying START. Refusing loudly here is the
    // difference between a control and a loophole.
    if (c.sms_opt_out_at) {
      return json({
        error: "This customer replied STOP. Only they can undo that, by replying START to that number.",
      }, 409);
    }

    const attestation = payload.attestation ? String(payload.attestation).trim().slice(0, 1000) : "";
    if (!attestation) return json({ error: "The permission statement is required." }, 400);
    const note = payload.note ? String(payload.note).trim().slice(0, 500) : "";

    const { error: insErr } = await admin.from("sms_consent_log").insert({
      client_id: clientId,
      phone_digits: c.phone_digits,
      contact_id: c.id,
      action: "granted",
      source: "operator",
      // The attestation IS the disclosure here — what the person recording it certified.
      disclosure_text: attestation,
      ip: clientIp(req),
      user_agent: (req.headers.get("user-agent") || "").slice(0, 300),
      detail: { recordedBy: userId ?? null, note: note || null },
    });
    if (insErr) {
      return dbFail(req, clientId, "record that permission", insErr);
    }
    return json({ ok: true });
  }

  if (action === "crm_send_email") {
    const claimedTo = String(payload.to ?? "").trim().slice(0, 320);
    const subject = String(payload.subject ?? "").trim().slice(0, 200);
    const body = String(payload.body ?? "").trim().slice(0, 20000);
    if (!subject) return json({ error: "Give the email a subject." }, 400);
    if (!body) return json({ error: "The email is empty." }, 400);

    const contactId = payload.contactId ? String(payload.contactId).slice(0, 64) : null;
    const shortCode = payload.shortCode ? String(payload.shortCode).slice(0, 32) : null;
    { const bad = await mismatchedPair(contactId, shortCode); if (bad) return bad; }

    // ── THE BROWSER SENDS IDS, NEVER AN ADDRESS ───────────────────────────────────────
    // Exactly the rule crm_send_sms and text_sign_link already state, applied to the channel
    // that carries far more of the conversation. Taking the recipient from the body made this
    // an open relay on the tenant's own verified domain: any login that may edit contacts
    // could put any address in `to` and send whatever it liked, DKIM-signed as the builder,
    // with the ledger row recording it as a customer conversation. The address is read HERE,
    // server-side, from the record the ids name.
    //
    // `to` stays in the contract (production's frontend sends it) and is now a CONFIRMATION:
    // if it disagrees with the record, the composer is pointed at a different customer than
    // the one the request claims, and the honest answer is to refuse rather than pick one.
    if (!contactId && !shortCode) {
      return json({ error: "An email has to be addressed to a contact or a deal." }, 400);
    }
    let to = "";
    // Shape-checked before it reaches Postgres: crm_contacts.id is a uuid, and a malformed one
    // would answer 22P02 and turn a bad id into a 500 rather than the refusal below.
    if (contactId && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(contactId)) {
      const { data: c, error: cErr } = await admin.from("crm_contacts")
        .select("email").eq("client_id", clientId).eq("id", contactId).maybeSingle();
      if (cErr) return dbFail(req, clientId, "look up that contact", cErr);
      to = String(c?.email ?? "").trim();
    }
    if (!to && shortCode) {
      // A design whose contact predates the migration-130 backfill has no crm_contacts row at
      // all — crm_record synthesizes the Person panel from this jsonb blob, so the composer
      // has to be able to reach the same address or those records lose the feature.
      const { data: dRow, error: dErr } = await admin.from("designs")
        .select("contact").eq("client_id", clientId).eq("short_code", shortCode).maybeSingle();
      if (dErr) return dbFail(req, clientId, "look up that deal", dErr);
      to = String((dRow?.contact as { email?: unknown } | null)?.email ?? "").trim();
    }
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(to)) {
      return json({ error: "This customer has no email address on file. Add one to the contact first." }, 400);
    }
    if (claimedTo && claimedTo.toLowerCase() !== to.toLowerCase()) {
      return json({ error: "That address doesn't match this customer's — reopen the record and try again." }, 400);
    }

    // REPLY-TO FALLBACK ONLY: the staff member who wrote it. There is no `business_email`
    // column to default a reply address from (emailSend.ts says so in as many words), and the
    // tenant's sending address is a no-reply-shaped local part, so a customer hitting Reply
    // needs somewhere real to land. The signed-in sender is the right answer, and it is
    // resolved SERVER-SIDE from the JWT rather than trusted from the body, so nobody can
    // route a customer's replies at a third party.
    //
    // The ROUTABLE address (`d.SS-…@reply.jrbarns.com`) used to be computed right here and is
    // now derived inside sendTenantEmail, where it covers all ten send paths instead of this
    // one. That move is the point: a customer replying to their QUOTE was never routed
    // anywhere, because quotes go through submit-estimate and only this branch had the code.
    // Do not reintroduce it here — sendTenantEmail prefers its own and falls back to this.
    let replyTo: string | undefined;
    try {
      const { data: u } = await admin.auth.admin.getUserById(userId ?? "");
      const addr = u?.user?.email;
      if (typeof addr === "string" && addr.includes("@")) replyTo = addr;
    } catch (_) { /* no reply-to is worse than failing to send, but not by much */ }
    // The person's OWN choice beats their login address (Settings → My View). A login and the
    // address someone wants customer replies at are often different — a shared `office@` login,
    // a personal alias, a role address — which is the gap Carolyn was describing.
    //
    // Their auth email stays the fallback: someone who has never opened that card must not lose
    // the reply address they have had all along. Read from client_users keyed on the JWT's
    // userId and NEVER on anything in the body, the same rule the auth lookup above follows —
    // which is why this is a second query rather than a field the browser could send.
    //
    // save_prefs validates this on the way IN, so it is not re-validated here. If that
    // whitelist is ever relaxed, re-validate at this end too: it goes into a mail header.
    try {
      const { data: pu } = await admin.from("client_users")
        .select("prefs").eq("user_id", userId ?? "").maybeSingle();
      const own = (pu?.prefs as Record<string, unknown> | null)?.replyToEmail;
      if (typeof own === "string" && own.includes("@")) replyTo = own.trim();
    } catch (_) { /* fall through to the auth email */ }

    // Plain text, escaped into a minimal HTML body. Deliberately NOT a rich template: a
    // conversation should look like a person typed it, not like a system notification, and
    // the branded template already exists for the documents that want one.
    const esc = (v: string) => v.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
    const html = `<div style="font-family:system-ui,-apple-system,'Segoe UI',sans-serif;font-size:15px;line-height:1.5;color:#1E293B;white-space:pre-wrap">${esc(body)}</div>`;

    const out = await sendTenantEmail(admin, clientId, {
      kind: "conversation",
      to,
      subject,
      html,
      text: body,
      ...(replyTo ? { replyTo } : {}),
      ...(shortCode ? { shortCode } : {}),
      // Carried so sendTenantEmail can build the threading Message-ID. Without it a
      // conversation email about no particular design gets no threading id, and a reply
      // could only be placed by the sender's address — which cannot tell two people at the
      // same company apart.
      ...(contactId ? { contactId } : {}),
    } as any);

    if (out.sent) {
      // sendTenantEmail owns the ledger row; stamp the contact scope onto it so the person's
      // whole email history surfaces on their record, including mail about no design at all.
      if (contactId) {
        await admin.from("email_sends").update({ contact_id: contactId })
          .eq("client_id", clientId).eq("kind", "conversation").eq("to_email", to)
          .is("contact_id", null).order("created_at", { ascending: false }).limit(1);
      }
      return json({ ok: true, messageId: out.messageId });
    }
    if (out.reason === "not_active") {
      // Not a fault: this tenant has not connected a sending domain yet. 503 is the closest
      // status, so it declares itself a refusal — otherwise every send attempt on an
      // un-onboarded tenant files as an error someone has to triage.
      const r = json({ error: "Email sending isn't switched on for your account yet — connect your sending domain in Settings → Email Sending." }, 503);
      // EXPOSED, or the browser cannot read it. A custom response header is invisible to
      // cross-origin JS unless it is named in Access-Control-Expose-Headers, and the portal
      // calls this function cross-origin. Without this line the mark is set, travels, and is
      // silently unreadable in the browser - so a deliberate 5xx refusal ("Taking cards is not
      // switched on for this account yet") kept filing as a FAULT in app_errors.
      r.headers.set(SS_REFUSAL_HEADER, "1");
      r.headers.set("Access-Control-Expose-Headers", SS_REFUSAL_HEADER);
      return r;
    }
    return json({ error: `That email didn't send${out.error ? ` (${out.error})` : ""}. Try again — if it keeps happening, tell CSM Synergy.` }, 502);
  }

  if (action === "crm_save_note") {
    const body = String(payload.body ?? "").trim().slice(0, 8000);
    if (!body) return json({ error: "A note needs some text." }, 400);
    const contactId = payload.contactId ? String(payload.contactId).slice(0, 64) : null;
    const shortCode = payload.shortCode ? String(payload.shortCode).slice(0, 32) : null;
    if (!contactId && !shortCode) return json({ error: "A note must attach to a contact or a design." }, 400);
    { const bad = await mismatchedPair(contactId, shortCode); if (bad) return bad; }
    const row: Record<string, unknown> = { client_id: clientId, body, created_by: userId ?? null };
    if (contactId) row.contact_id = contactId;
    if (shortCode) row.short_code = shortCode;
    if (payload.id) {
      const { error } = await admin.from("crm_notes").update({ body, pinned: Boolean(payload.pinned) })
        .eq("client_id", clientId).eq("id", String(payload.id));
      if (error) return dbFail(req, clientId, "save that note", error);
      return json({ ok: true });
    }
    row.pinned = Boolean(payload.pinned);
    const { data, error } = await admin.from("crm_notes").insert(row).select("id").single();
    if (error) return dbFail(req, clientId, "save that note", error);
    return json({ ok: true, id: data?.id });
  }

  if (action === "crm_delete_note") {
    // SOFT delete: a note is evidence of what a customer was told and when.
    const { error } = await admin.from("crm_notes").update({ deleted_at: new Date().toISOString() })
      .eq("client_id", clientId).eq("id", String(payload.id ?? ""));
    if (error) return dbFail(req, clientId, "delete that note", error);
    return json({ ok: true });
  }

  if (action === "crm_save_activity") {
    const KINDS = ["call", "meeting", "task", "deadline", "email", "lunch"];
    const kind = KINDS.includes(String(payload.kind)) ? String(payload.kind) : "task";
    const subject = String(payload.subject ?? "").trim().slice(0, 300);
    if (!subject) return json({ error: "An activity needs a subject." }, 400);
    const contactId = payload.contactId ? String(payload.contactId).slice(0, 64) : null;
    const shortCode = payload.shortCode ? String(payload.shortCode).slice(0, 32) : null;
    if (!contactId && !shortCode) return json({ error: "An activity must attach to a contact or a design." }, 400);
    { const bad = await mismatchedPair(contactId, shortCode); if (bad) return bad; }
    const row: Record<string, unknown> = {
      client_id: clientId, kind, subject,
      due_at: payload.dueAt ? new Date(String(payload.dueAt)).toISOString() : null,
      assignee_user_id: userId ?? null, created_by: userId ?? null,
    };
    if (contactId) row.contact_id = contactId;
    if (shortCode) row.short_code = shortCode;
    const { data, error } = await admin.from("crm_activities").insert(row).select("id").single();
    if (error) return dbFail(req, clientId, "save that activity", error);
    return json({ ok: true, id: data?.id });
  }

  if (action === "crm_complete_activity") {
    const done = payload.done !== false;
    const { error } = await admin.from("crm_activities")
      .update({ done, done_at: done ? new Date().toISOString() : null })
      .eq("client_id", clientId).eq("id", String(payload.id ?? ""));
    if (error) return dbFail(req, clientId, "update that activity", error);
    return json({ ok: true });
  }

  // ── EDIT A CONTACT FROM THE RECORD PAGE ────────────────────────────────────────────
  // Carolyn, 2026-08-26 11:19, with the person card circled on her screen: "I want to be
  // able to click on person and be able to make changes to it right here. I don't want to
  // switch the screen."
  //
  // The write itself is one SECURITY DEFINER call (migration 141) rather than an update
  // here, because three things have to happen together: the row changes, phone_digits is
  // rederived through crm_phone_key, and one changelog row is written per field that moved.
  // Doing that in three statements from here would let a save land with no audit trail —
  // and the audit trail is the other half of what she asked for (25:18, "everything that
  // they did with that lead was logged").
  //
  // NULL means "leave this field alone"; "" means "clear it". crm_ensure_contact cannot
  // express the second — it is enrich-never-blank by design, because anonymous design
  // submissions feed it — which is exactly why a human editor needs its own function.
  if (action === "crm_save_contact") {
    const id = String(payload.id ?? "").slice(0, 64);
    if (!id) return json({ error: "A contact id is required." }, 400);
    // undefined => not being edited. An empty string is a real instruction to clear.
    const fld = (v: unknown, max: number) => (v === undefined || v === null ? null : String(v).trim().slice(0, max));
    const name = fld(payload.name, 200);
    const phone = fld(payload.phone, 40);
    const email = fld(payload.email, 320);
    // Address (166). Carolyn, 2026-08-28 @21:01: "We still need like address. You have it in
    // here, but everything that is contact related should be in here." The columns have
    // existed since 130 and were populated from submitted designs -- only the editor was
    // missing. Same undefined/""/value contract as the three above.
    const street = fld(payload.street, 200);
    const city = fld(payload.city, 120);
    const state = fld(payload.state, 60);
    const zip = fld(payload.zip, 20);
    // Billing address (188). A customer's building goes to one address and their paperwork to
    // another. The four above stay the DELIVERY address — that is what a design submission
    // populates and what a delivery stop is built from — so these are four more fields, not a
    // relabelling of those.
    const billingStreet = fld(payload.billingStreet, 200);
    const billingCity = fld(payload.billingCity, 120);
    const billingState = fld(payload.billingState, 60);
    const billingZip = fld(payload.billingZip, 20);
    // OWNER (188). Carolyn 2026-09-04: "we do not ever assign deals. We only assign contacts
    // and followers." Same three-state contract as every field here, which is why it travels
    // as TEXT: "" is a real instruction to UNASSIGN, and a uuid cannot carry it.
    const owner = fld(payload.owner, 64);
    if (name === null && phone === null && email === null
        && street === null && city === null && state === null && zip === null
        && billingStreet === null && billingCity === null && billingState === null
        && billingZip === null && owner === null) {
      return json({ error: "Nothing to change." }, 400);
    }
    // Only validate an address that is actually being SET. "" is a deliberate clear and
    // must not be refused as malformed.
    if (email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
      return json({ error: "That doesn't look like an email address." }, 400);
    }
    // Shape-check the owner here so a mangled value gets a sentence rather than a Postgres
    // cast error routed through dbFail. Membership is NOT checked here — the function does
    // that, in the same statement as the write, so the check cannot be true when it is made
    // and false when the row lands.
    if (owner && !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(owner)) {
      return json({ error: "Pick the owner from the list — that isn't a team member." }, 400);
    }
    const { data: n, error } = await admin.rpc("crm_update_contact", {
      p_client_id: clientId, p_id: id,
      p_name: name, p_phone: phone, p_email: email,
      p_actor: userId ?? null,
      p_street: street, p_city: city, p_state: state, p_zip: zip,
      p_owner: owner,
      p_billing_street: billingStreet, p_billing_city: billingCity,
      p_billing_state: billingState, p_billing_zip: billingZip,
    });
    if (error) {
      // The tenant-wide partial unique index on (client_id, phone_digits) — migration 130.
      // Typing a phone that already belongs to somebody else is a real thing a person does,
      // and "duplicate key value violates unique constraint" is not an answer they can act
      // on. Say which field, and what it means.
      if (String(error.code) === "23505") {
        return json({ error: "Another contact already has that phone number. Open that contact instead, or clear the number there first." }, 409);
      }
      if (String(error.code) === "P0002" || /contact not found/i.test(String(error.message ?? ""))) {
        return json({ error: "That contact no longer exists." }, 404);
      }
      // The two refusals crm_update_contact raises for the owner (188). They are the server
      // saying no, not something breaking, so they answer with our own sentence rather than
      // going through dbFail — the same split the error contract has always drawn between
      // text we wrote and text we did not.
      if (/owner is not on this team/i.test(String(error.message ?? ""))) {
        return json({ error: "That person isn't on this team any more. Pick someone from the list." }, 400);
      }
      if (/owner must be a user id/i.test(String(error.message ?? ""))) {
        return json({ error: "Pick the owner from the list — that isn't a team member." }, 400);
      }
      return dbFail(req, clientId, "save that contact", error);
    }
    return json({ ok: true, changed: Number(n ?? 0) });
  }

  if (action === "contact_activity") {
    const rawCodes: string[] = Array.isArray(payload?.codes)
      ? payload.codes.map((c: unknown) => String(c)).filter(Boolean).slice(0, 50)
      : [];
    // ── ROW SCOPE (migration 193) ──────────────────────────────────────────────────────
    // The codes are caller-supplied, so they are narrowed BEFORE any of the four reads
    // below rather than after: `codes` also drives the GHL estimate lookup and the
    // invoice_sends read, and filtering only the returned designs would leave those two
    // answering about somebody else's customer.
    const codes = await visibleShortCodes(rawCodes);
    if (!codes) return dbFail(req, clientId, "check who these customers are assigned to", { message: "contact scope unavailable" });
    if (codes.length === 0) return json({ ok: true, designs: [], versions: [], estimates: {} });

    const [dRes, vRes] = await Promise.all([
      admin.from("designs")
        .select("short_code, created_at, updated_at, status, selections, items, ghl_estimate_number, ghl_estimate_id")
        .eq("client_id", clientId).in("short_code", codes),
      admin.from("design_versions")
        .select("short_code, version, created_at, selections, paint_colors, image_url")
        .eq("client_id", clientId).in("short_code", codes)
        .order("version", { ascending: true }),
    ]);
    if (dRes.error) return dbFail(req, clientId, "load this contact's designs", dRes.error);
    if (vRes.error) return dbFail(req, clientId, "load this contact's design history", vRes.error);

    // GHL estimate events for these designs' estimates (best-effort — timeline still
    // renders from DB data if GHL is unreachable/unconfigured).
    const estimates: Record<string, unknown> = {};
    const wantIds = new Set((dRes.data ?? []).map((d: any) => String(d.ghl_estimate_id || "")).filter(Boolean));
    if (wantIds.size > 0) {
      const { data: cur } = await admin.from("client_settings")
        .select("ghl_location_id, ghl_api_key").eq("client_id", clientId).maybeSingle();
      if (cur?.ghl_location_id && cur?.ghl_api_key) {
        const ghlHeaders = {
          Authorization: `Bearer ${cur.ghl_api_key}`,
          Version: "2021-07-28",
          Accept: "application/json",
        };
        try {
          const limit = 100;
          for (let offset = 0; offset < 2000; offset += limit) {
            const url = `https://services.leadconnectorhq.com/invoices/estimate/list?altId=${encodeURIComponent(cur.ghl_location_id)}&altType=location&limit=${limit}&offset=${offset}`;
            const r = await fetch(url, { headers: ghlHeaders });
            if (!r.ok) break;
            const d = await r.json();
            const arr: any[] = Array.isArray(d?.estimates) ? d.estimates : [];
            for (const e of arr) {
              const id = String(e?._id ?? "");
              if (wantIds.has(id)) {
                estimates[id] = {
                  estimateStatus: e?.estimateStatus ?? null,
                  estimateNumber: e?.estimateNumber ?? null,
                  createdAt: e?.createdAt ?? null,
                  lastVisitedAt: e?.lastVisitedAt ?? null,      // customer opened the estimate
                  // GHL's estimateActionHistory[].updatedAt is the LOCATION's local time with
                  // NO timezone suffix (verified 2026-07-25: history "…T02:39:13" for an estimate
                  // whose real updatedAt was "…T07:39:13.211Z" — the tenant's Central offset), so
                  // the browser would misparse it. `updatedAt` IS zoned, so the UI uses it for the
                  // current status event instead of trusting the history stamp.
                  updatedAt: e?.updatedAt ?? null,
                  history: Array.isArray(e?.estimateActionHistory) ? e.estimateActionHistory : [],
                };
              }
            }
            if (arr.length < limit) break;
          }
        } catch (_e) { /* best-effort */ }
      }
    }
    // Invoice-send ledger state for these designs (migration 052). Lets the drawer show
    // "invoice created but not emailed — retry" instead of silently looking invoiced.
    const { data: sends } = await admin
      .from("invoice_sends")
      .select("short_code, status, invoice_number, error, updated_at")
      .eq("client_id", clientId).in("short_code", codes);

    return json({ ok: true, designs: dRes.data ?? [], versions: vRes.data ?? [], estimates, invoiceSends: sends ?? [] });
  }

  // ── QuickBooks Online ─────────────────────────────────────────────────────────────
  // Connection status + item-mapping grid. Deliberately its OWN select rather than a
  // widening of the "status" action's hand-enumerated list — QuickBooks state changes on
  // a different cadence and the existing card stays untouched.

  // Invoices that were EMAILED but never reached QuickBooks. Without this the whole QBO push was
  // write-only: every outcome was recorded on invoice_sends (qbo_error / qbo_invoice_id) and a
  // retry_qbo_push action existed, but nothing in the portal read either — so send_invoice returned
  // {ok:true, sent:true}, the design showed "Invoiced", and a push that aborted (typically an
  // unmapped line) left the books silently untouched with no way to notice or retry short of
  // calling the edge function by hand. Owner/admin: absent from READ_ACTIONS on purpose, since it
  // exposes bookkeeping state.
  if (action === "qbo_pending") {
    const { data, error } = await admin.from("invoice_sends")
      .select("short_code, invoice_number, qbo_error, qbo_attempts, updated_at")
      .eq("client_id", clientId).eq("status", "sent")
      .is("qbo_invoice_id", null).not("qbo_error", "is", null)
      .order("updated_at", { ascending: false }).limit(50);
    if (error) return dbFail(req, clientId, "load your pending QuickBooks pushes", error);
    return json({
      ok: true, clientId,
      pending: (data ?? []).map((r: any) => ({
        shortCode: r.short_code,
        invoiceNumber: r.invoice_number ?? null,
        // Already operator-facing text written by our own code (e.g. "unmapped: … — map these
        // under Settings → QuickBooks, then Retry"), so it is safe to show as-is.
        error: String(r.qbo_error ?? "").slice(0, 300),
        attempts: Number(r.qbo_attempts) || 0,
        at: r.updated_at ?? null,
      })),
    });
  }

  if (action === "qbo_status") {
    const { data, error } = await admin
      .from("client_settings")
      .select("qbo_realm_id, qbo_company_name, qbo_connected_at, qbo_refresh_error, qbo_refresh_token_expires_at, qbo_disconnect_reason")
      .eq("client_id", clientId)
      .maybeSingle();
    if (error) return dbFail(req, clientId, "load your QuickBooks connection", error);

    const connected = !!data?.qbo_realm_id && !!data?.qbo_connected_at;
    const { count } = await admin
      .from("qbo_item_map")
      .select("id", { count: "exact", head: true })
      .eq("client_id", clientId);

    // Never tokens, never the full realm id. The company NAME is the human handle.
    return json({
      clientId, // operator view-as tripwire
      oauthReady: qboOauthReady(),
      connected,
      companyName: data?.qbo_company_name ?? null,
      realmIdMasked: maskId(data?.qbo_realm_id ?? null),
      connectedAt: data?.qbo_connected_at ?? null,
      broken: connected && !!data?.qbo_refresh_error,
      brokenReason: data?.qbo_refresh_error ?? null,
      refreshTokenExpiresAt: data?.qbo_refresh_token_expires_at ?? null,
      // Only meaningful while NOT connected: why it stopped, when the tenant did not stop it
      // themselves (today: another account took the QuickBooks company over — migration 084).
      // Without this the displaced tenant just finds a bare "Connect QuickBooks" card and no
      // explanation for why their invoices quietly stopped syncing.
      disconnectReason: data?.qbo_connected_at ? null : (data?.qbo_disconnect_reason ?? null),
      mappedCount: count ?? 0,
    });
  }

  if (action === "list_item_map") {
    const [maps, styles, items, types] = await Promise.all([
      admin.from("qbo_item_map")
        .select("id, line_kind, item_key, style_id, qbo_item_id, qbo_item_name")
        .eq("client_id", clientId),
      admin.from("building_styles")
        .select("id, label, active").eq("client_id", clientId).eq("active", true),
      // label_override, NOT label: this table has no `label` column (it overrides the
      // designer's built-in name), and PostgREST answers a bad column with a 400 rather
      // than omitting it — so the old `label` select returned error + null data, the
      // `?? []` below turned that into an empty list, and the grid rendered "No active
      // layout items" for EVERY tenant. Layout items were therefore unmappable in the UI,
      // sending every layout_item line (built-in doors/windows/ramps, lofts, workbenches,
      // rough openings) to the tenant's `fallback` item instead. Sort so the grid order is
      // stable rather than whatever Postgres returns.
      admin.from("client_layout_items")
        .select("item_key, label_override, active, sort_order")
        .eq("client_id", clientId).eq("active", true)
        .order("sort_order", { ascending: true }).order("item_key", { ascending: true }),
      // The designer's built-in names, so the grid reads "Rough Opening" rather than the raw
      // `roughOpening` key. Same three-step fallback the `catalog` action above already uses.
      admin.from("layout_item_types").select("item_key, label"),
    ]);
    if (maps.error) return dbFail(req, clientId, "load your QuickBooks mappings", maps.error);
    // Checked, not `?? []`-swallowed: an empty layoutItems list is indistinguishable from a
    // tenant with none, which is exactly how the bug above stayed invisible. Same for styles —
    // a silent empty there hides every per-style building override.
    if (styles.error) return dbFail(req, clientId, "load your building styles", styles.error);
    if (items.error) return dbFail(req, clientId, "load your option list", items.error);
    // types is presentation-only: a failure here costs nicer labels, not correctness, so it
    // degrades to the item_key instead of failing the whole grid.
    const labelByKey: Record<string, string> = {};
    (types.data ?? []).forEach((t: any) => { labelByKey[t.item_key] = t.label; });
    return json({
      clientId,
      mappings: maps.data ?? [],
      styles: styles.data ?? [],
      layoutItems: (items.data ?? []).map((li: any) => ({
        item_key: li.item_key,
        // Passed through as `label` to keep portal.html's `li.label || li.item_key` contract
        // unchanged; tenant override wins, then the built-in name, then the bare key.
        label: li.label_override || labelByKey[li.item_key] || null,
        active: li.active,
      })),
    });
  }

  if (action === "save_item_map") {
    // rows: [{ lineKind, itemKey?, styleId?, qboItemId, qboItemName? }]
    // Blank qboItemId = delete that mapping. MANUAL upsert, not PostgREST onConflict:
    // the table's uniqueness lives in two partial indexes, which onConflict cannot
    // infer (same documented reason as save_layout_pricing above).
    if (!Array.isArray(payload?.rows)) return json({ error: "rows[] required" }, 400);
    { const e = tooMany(payload.rows, "mappings"); if (e) return json({ error: e }, 400); }

    // The line kinds come from _shared/qboLineKinds.ts, which a test pins to the table's CHECK and
    // to the portal grid. This used to be a local 11-kind copy that migration 239 left behind, so
    // every mapping for the seven kinds 239 added was skipped as "unknown line kind".

    // Validate against the tenant's OWN catalog — an item key or style id from another
    // tenant must not be writable here.
    const [itemsRes, stylesRes, exRes] = await Promise.all([
      admin.from("client_layout_items").select("item_key").eq("client_id", clientId).eq("active", true),
      admin.from("building_styles").select("id").eq("client_id", clientId),
      admin.from("qbo_item_map").select("id, line_kind, item_key, style_id").eq("client_id", clientId),
    ]);
    if (exRes.error) return dbFail(req, clientId, "read your current QuickBooks mappings", exRes.error);
    const validKeys = new Set((itemsRes.data ?? []).map((i: any) => i.item_key));
    const validStyles = new Set((stylesRes.data ?? []).map((s: any) => s.id));
    const keyOf = (k: string, ik: string, sid: string | null) => `${k}|${ik}|${sid ?? ""}`;
    const idByKey = new Map<string, string>();
    for (const r of exRes.data ?? []) idByKey.set(keyOf(r.line_kind, r.item_key, r.style_id), r.id);

    let saved = 0, deleted = 0;
    const skipped: string[] = [];
    for (const row of payload.rows) {
      const lineKind = String(row?.lineKind ?? "").trim();
      const itemKey = String(row?.itemKey ?? "").trim();
      const styleId = row?.styleId ? String(row.styleId) : null;
      const qboItemId = String(row?.qboItemId ?? "").trim();
      const qboItemName = String(row?.qboItemName ?? "").trim() || null;

      if (!isQboLineKind(lineKind)) { skipped.push(`${lineKind || "(blank)"}: unknown line kind`); continue; }
      if ((lineKind === "layout_item") !== (itemKey !== "")) { skipped.push(`${lineKind}: item key ${itemKey ? "not allowed" : "required"}`); continue; }
      if (itemKey && !validKeys.has(itemKey)) { skipped.push(`${itemKey}: not an enabled item`); continue; }
      if (styleId && !validStyles.has(styleId)) { skipped.push(`${lineKind}: unknown style`); continue; }
      if (styleId && !(lineKind === "building" || lineKind === "layout_item")) { skipped.push(`${lineKind}: style override not supported`); continue; }

      const existingId = idByKey.get(keyOf(lineKind, itemKey, styleId));
      if (!qboItemId) {
        if (existingId) {
          const del = await admin.from("qbo_item_map").delete().eq("id", existingId);
          if (del.error) { skipped.push(`${lineKind}: ${del.error.message}`); continue; }
          deleted++;
        }
        continue;
      }
      const res = existingId
        ? await admin.from("qbo_item_map")
            .update({ qbo_item_id: qboItemId, qbo_item_name: qboItemName, updated_at: new Date().toISOString() })
            .eq("id", existingId)
        : await admin.from("qbo_item_map")
            .insert({ client_id: clientId, line_kind: lineKind, item_key: itemKey, style_id: styleId, qbo_item_id: qboItemId, qbo_item_name: qboItemName });
      if (res.error) { skipped.push(`${lineKind}: ${res.error.message}`); continue; }
      saved++;
    }

    await audit("qbo_save_item_map", saved + deleted, skipped.length ? `${skipped.length} skipped` : null);
    return json({ ok: true, saved, deleted, skipped, clientId });
  }

  if (action === "list_qbo_items") {
    // Server-side QBO query; the token never leaves this function (the
    // list_ghl_pipelines doctrine). Fed to the mapping grid's dropdowns.
    //
    // "Not connected" and "needs reconnect" answer 200 with NO `error` key, because they are
    // STATES, not failures — the connection card above the grid already reports both, and this
    // call is made automatically on render, by an effect the user never asked for. Returning
    // 400/409 here was doubly wrong: portal.html's invoke wrapper files anything with a
    // non-2xx or an `error` body into app_errors (so an ordinary disconnect raised an incident
    // — this is the 2026-08-03 FunctionsHttpError), and supabase-js collapses a non-2xx into
    // "Edge Function returned a non-2xx status code", throwing away the readable reason on the
    // way. Only a genuine QuickBooks-side failure below is worth an error, and it keeps 502.
    const conn = await getQboConnection(admin, clientId);
    if (!conn.connected) return json({ items: [], notConnected: true, clientId });
    if (conn.broken) return json({ items: [], broken: true, clientId });
    try {
      // PAGED. A single `maxresults 1000` silently truncated any company with more items
      // than that, and there was no way to tell a complete list from a clipped one — the
      // grid just wouldn't offer the item you were looking for. Real shed books run to
      // hundreds of rows (base buildings plus an "OP …" line per option), so this is not
      // hypothetical. The cap exists so a pathological book can't hold the request open
      // forever; when it bites we SAY so rather than pretending the list is whole.
      const PAGE = 1000, MAX_PAGES = 5;
      // Explicit column list, not `select *`: * returns account/tax refs and purchase costs
      // we never read — roughly ten times the payload for the same dropdown.
      // FullyQualifiedName is the item's category path ("Options:Doors:OP Door 4");
      // ParentRef is deliberately NOT fetched, because resolving those ids to names would
      // mean keeping the very Category rows we drop below.
      const COLS = "Id, Name, Type, Active, FullyQualifiedName";
      const pageQuery = (cols: string, page: number, paged: boolean) => encodeURIComponent(
        `select ${cols} from Item where Active = true`
        + (paged ? ` startposition ${page * PAGE + 1} maxresults ${PAGE}` : ` maxresults ${PAGE}`),
      );
      const fetchPage = (cols: string, page: number, paged: boolean) =>
        qboFetch(admin, clientId, conn.realmId as string, `/query?query=${pageQuery(cols, page, paged)}&minorversion=75`);

      const raw: any[] = [];
      let truncated = false;
      let cols = COLS, paged = true;
      for (let page = 0; page < MAX_PAGES; page++) {
        let body: any;
        try {
          body = await fetchPage(cols, page, paged);
        } catch (qe) {
          // A connection problem is not a query problem — let those through to the outer
          // catch, which has the right answer for each.
          if (qe instanceof QboBroken || qe instanceof QboNotConnected) throw qe;
          // Otherwise: this shape was rejected. Fall back ONCE to the long-standing query
          // (no qualified name, no startposition) so a dialect surprise degrades to the
          // old behaviour — an unsorted list of up to 1000 items — instead of an empty
          // dropdown that blocks all mapping work. Only worth trying on the first page;
          // a failure deeper in means paging itself worked.
          if (page > 0 || cols === "Id, Name, Type, Active") throw qe;
          cols = "Id, Name, Type, Active"; paged = false;
          body = await fetchPage(cols, 0, false);
        }
        const rows = body?.QueryResponse?.Item ?? [];
        raw.push(...rows);
        if (!paged) { truncated = rows.length >= PAGE; break; }
        if (rows.length < PAGE) break;
        if (page === MAX_PAGES - 1) truncated = true;
      }
      // Categories are Item rows in QuickBooks, so they arrive mixed in with real products
      // — and they are NOT usable as an invoice ItemRef. Offering them meant a mapping that
      // looked fine and then failed the whole push with an Intuit 400. Filtered here rather
      // than in the query: QBO's SQL dialect has no `!=`, and enumerating the allowed types
      // would silently drop whatever type Intuit adds next.
      const items = raw
        .filter((i: any) => i.Type !== "Category")
        .map((i: any) => ({
          id: String(i.Id),
          name: i.Name ?? String(i.Id),
          type: i.Type ?? "",
          fullName: i.FullyQualifiedName ?? "",
        }));
      // `id`/`name`/`type` keep their old meaning on purpose: production portal.html groups
      // by `type` until the next Monday promotion, and both hosts call THIS one function.
      return json({ items, ...(truncated ? { truncated: true } : {}), clientId });
    } catch (e) {
      // Still reachable: the connection can die between the check above and the call landing.
      if (e instanceof QboBroken) return json({ items: [], broken: true, clientId });
      if (e instanceof QboNotConnected) return json({ items: [], notConnected: true, clientId });
      // The tid rides along as a support ref rather than a second app_errors row: withErrorLog
      // already records this 502 and reads its message from the body, so appending the ref puts
      // the trace id in app_errors through the path that exists — and gives whoever reports the
      // problem something Intuit can look up. Opaque id, no customer data, safe to show.
      const ref = e instanceof QboApiError && e.tid ? ` (ref ${e.tid})` : "";
      return json({ error: `Could not load items from QuickBooks. Try again shortly.${ref}` }, 502);
    }
  }

  if (action === "qbo_test") {
    // On-demand probe via CompanyInfo THROUGH the token helper, so an expired access
    // token exercises the refresh path — which is exactly what a "Test" should prove.
    //
    // Unlike list_qbo_items this KEEPS its `error` key (and the app_errors row that follows):
    // the Test button only renders on a card that believes it is connected, so a
    // not-connected answer means the page is stale in a way worth a trace. What it must not
    // do is lie about WHY — reading the disconnect tombstone as connected sent this down the
    // catch below and reported "Could not reach QuickBooks", which starts someone hunting a
    // network fault that does not exist.
    const conn = await getQboConnection(admin, clientId);
    if (!conn.connected) return json({ ok: false, error: "QuickBooks is not connected.", clientId }, 200);
    try {
      const body = await qboFetch(admin, clientId, conn.realmId as string,
        `/companyinfo/${conn.realmId}?minorversion=75`);
      const name = body?.CompanyInfo?.CompanyName ?? null;
      if (name) {
        // Keep the stored name current — it may have been edited in QuickBooks.
        await admin.from("client_settings")
          .update({ qbo_company_name: name }).eq("client_id", clientId);
      }
      return json({ ok: true, companyName: name, clientId });
    } catch (e) {
      if (e instanceof QboBroken) return json({ ok: false, broken: true, error: "QuickBooks refused the connection — reconnect to restore it.", clientId }, 200);
      // Same support ref as list_qbo_items. This one answers 200 deliberately (see above), so
      // the app_errors row comes from portal.html's invoke wrapper filing any `error` body —
      // which means the ref reaches triage by that route instead.
      const ref = e instanceof QboApiError && e.tid ? ` (ref ${e.tid})` : "";
      return json({ ok: false, error: `Could not reach QuickBooks. Try again shortly.${ref}`, clientId }, 200);
    }
  }

  if (action === "disconnect_qbo") {
    // Idempotent: disconnecting an already-disconnected tenant is a no-op success, not an
    // error. Guarding on the realm alone made this "succeed" against a tombstone — writing a
    // second qbo_disconnect audit row asserting a disconnect that had already happened, and
    // re-running the revoke below with a refresh token that is null by then anyway.
    const conn = await getQboConnection(admin, clientId);
    if (!conn.connected) return json({ ok: true, alreadyDisconnected: true, clientId });

    const { data: cs } = await admin.from("client_settings")
      .select("qbo_refresh_token").eq("client_id", clientId).maybeSingle();

    // Best-effort revoke at Intuit — a failure here must not block the disconnect.
    const id = Deno.env.get("QBO_CLIENT_ID"), secret = Deno.env.get("QBO_CLIENT_SECRET");
    if (id && secret && cs?.qbo_refresh_token) {
      const { revoke: revokeUrl } = await qboEndpoints();
      await fetch(revokeUrl, {
        method: "POST",
        headers: {
          Authorization: `Basic ${btoa(`${id}:${secret}`)}`,
          "Content-Type": "application/json",
          Accept: "application/json",
        },
        body: JSON.stringify({ token: cs.qbo_refresh_token }),
      }).catch(() => {});
    }

    // KEEP qbo_realm_id (tombstone) and KEEP qbo_item_map: reconnecting the SAME company
    // must not lose mapping work — the callback only wipes the map when the realm CHANGES.
    // Side effect of the tombstone + unique index: this company cannot be attached to a
    // DIFFERENT tenant while the tombstone stands; moving a company between tenants means
    // clearing qbo_realm_id here first. That friction is intentional.
    const { error } = await admin.from("client_settings").update({
      qbo_access_token: null,
      qbo_access_token_expires_at: null,
      qbo_refresh_token: null,
      qbo_refresh_token_expires_at: null,
      qbo_connected_at: null,
      qbo_refresh_error: null,
      qbo_refreshing_at: null,
      qbo_oauth_state: null,
      qbo_oauth_state_expires_at: null,
      // This tenant chose to disconnect, so any "another account took your company" note from
      // an earlier displacement is now stale and must not sit on the card explaining THIS one.
      qbo_disconnect_reason: null,
    }).eq("client_id", clientId);
    if (error) return dbFail(req, clientId, "disconnect QuickBooks", error);

    await auditStrict("qbo_disconnect", 1, `realm kept as tombstone`);
    return json({ ok: true, clientId });
  }

  // ── Email sending (Settings → Email Sending) ────────────────────────────────────
  // Own-domain estimate/invoice email, Resend-backed — the provider never appears in
  // tenant-facing copy. Connection state lives on client_settings (migration 107):
  // not_configured → pending (connect: domain created, DNS records handed out) →
  // verified (the domain-level status). `active` (email_provider = 'resend') is a SEPARATE
  // explicit switch — a verify never auto-flips it, and turning it off is the instant
  // per-tenant rollback to the GHL sender. Response field names are the EmailSendingView
  // contract (portal.html ~10504) — change both or neither.

  if (action === "email_status") {
    const { data: s, error } = await admin
      .from("client_settings")
      .select("email_provider, email_domain, email_from_local, email_from_name, email_domain_status, email_dns_records, email_verified_at, email_last_error, email_template_copy, inbound_domain, inbound_status, inbound_dns_records, inbound_verified_at, inbound_last_error")
      .eq("client_id", clientId)
      .maybeSingle();
    if (error) return dbFail(req, clientId, "load your email sending settings", error);
    const { data: sends, error: sendsErr } = await admin
      .from("email_sends")
      .select("id, kind, to_email, status, error, bounce_reason, created_at")
      .eq("client_id", clientId)
      .order("created_at", { ascending: false })
      .limit(10);
    if (sendsErr) return dbFail(req, clientId, "load your recent emails", sendsErr);
    const domain = s?.email_domain ?? null;
    const fromLocal = (typeof s?.email_from_local === "string" && s.email_from_local.trim()) || "info";
    return json({
      clientId, // operator view-as tripwire (the qbo_status pattern)
      platformReady: resendConfigured(),
      // So the Email Sending screen prefills the wording boxes without a second round trip.
      templateCopy: s?.email_template_copy ?? null,
      domainStatus: s?.email_domain_status ?? "not_configured",
      domain,
      fromName: s?.email_from_name ?? null,
      fromLocal,
      fromAddress: domain ? `${fromLocal}@${domain}` : null,
      verifiedAt: s?.email_verified_at ?? null,
      lastError: s?.email_last_error ?? null,
      active: s?.email_provider === "resend",
      dnsRecords: Array.isArray(s?.email_dns_records) ? s.email_dns_records : [],
      // ── Receiving replies ────────────────────────────────────────────────────────────
      // One nested block rather than five loose keys, so the screen can render the whole
      // receiving card from a single object and a future provider swap changes one shape.
      // `replyExample` is built HERE because the address format is the webhook's contract
      // (parseReplyToken), not the UI's — a builder is shown the real thing, and the two
      // spellings cannot drift apart in a JSX template nobody tests.
      inbound: {
        status: s?.inbound_status ?? "off",
        domain: s?.inbound_domain ?? null,
        dnsRecords: Array.isArray(s?.inbound_dns_records) ? s.inbound_dns_records : [],
        verifiedAt: s?.inbound_verified_at ?? null,
        lastError: s?.inbound_last_error ?? null,
        replyExample: s?.inbound_domain ? `d.ss-9r8uhjgtdj@${s.inbound_domain}` : null,
      },
      // deno-lint-ignore no-explicit-any
      recentSends: (sends ?? []).map((r: any) => ({
        id: r.id, kind: r.kind, to: r.to_email, status: r.status,
        error: r.error ?? null, bounceReason: r.bounce_reason ?? null, createdAt: r.created_at,
      })),
    });
  }

  // Per-tenant SUBJECT / INTRO copy for the document emails (migration 138).
  //
  // ⚠️ COPY ONLY. The stored value is plain text with {token} placeholders — never HTML.
  // A free-HTML template authored by a tenant would be an injection surface pointed at a
  // customer's inbox, and would also let a wording edit silently break the quote link and
  // the totals table, which are the parts of the email that actually do something.
  // tenantCopy() in _shared/emailTemplates.ts re-validates on the way OUT as well, so a row
  // written before this check existed still cannot inject.
  if (action === "email_save_template") {
    const KINDS = ["estimate", "quote", "invoice"];
    const raw = payload?.copy;
    if (!raw || typeof raw !== "object") return json({ error: "Nothing to save." }, 400);
    const clean: Record<string, { subject?: string; subjectLen?: number; intro?: string }> = {};
    for (const kind of KINDS) {
      const v = (raw as any)[kind];
      if (!v || typeof v !== "object") continue;
      const take = (x: unknown) => {
        const t = typeof x === "string" ? x.replace(/\s+/g, " ").trim() : "";
        if (!t) return "";
        // Refuse LOUDLY rather than stripping: a builder who pasted markup needs to be told,
        // not to have it silently vanish and wonder which half saved.
        if (/[<>]/.test(t)) throw new Error(`Remove the < > characters from the ${kind} ${x === v.subject ? "subject" : "message"} — this is plain text, not HTML.`);
        return t.slice(0, 300);
      };
      try {
        const subject = take(v.subject), intro = take(v.intro);
        if (subject || intro) clean[kind] = { ...(subject ? { subject } : {}), ...(intro ? { intro } : {}) };
      } catch (e) {
        return json({ error: e instanceof Error ? e.message : "That template could not be saved." }, 400);
      }
    }
    const { error } = await admin.from("client_settings")
      .update({ email_template_copy: Object.keys(clean).length ? clean : null })
      .eq("client_id", clientId);
    if (error) return dbFail(req, clientId, "save that email wording", error);
    return json({ ok: true, copy: clean });
  }

  if (action === "email_connect_domain") {
    // Normalize what people actually paste: a URL ("https://mybarn.com/contact"), a full
    // address, a trailing dot, uppercase. What's left must LOOK like a registrable host,
    // and must not be one of ours — a tenant "verifying" a platform domain would be
    // claiming the sender identity every other tenant's fallback email rides on.
    let domain = String(payload?.domain ?? "").trim().toLowerCase();
    domain = domain.replace(/^[a-z]+:\/\//, "");     // pasted with a protocol
    domain = domain.replace(/^[^@/]*@/, "");         // pasted a full address — keep the domain half
    domain = domain.split(/[/?#]/)[0];               // pasted with a path/query
    domain = domain.split(":")[0];                   // pasted with a port
    domain = domain.replace(/\.+$/, "");             // trailing dot(s)
    // A LEADING www. IS NEVER A SENDING DOMAIN, and leaving it produced a silent split
    // brain: Resend normalizes "www.example.com" to "example.com" and registers the DKIM,
    // MX and SPF records against the APEX, while we stored the www form. Every downstream
    // reader then disagreed with the provider — the From address became
    // carolyn@www.csmsynergy.com (a host with no DKIM), the DMARC helper row pointed at
    // _dmarc.www.csmsynergy.com, and the reports address was one that cannot receive mail.
    // It cost a real tenant an afternoon on 2026-08-26. Nobody sends mail from a www host,
    // so there is no case where stripping this is wrong.
    domain = domain.replace(/^www\./, "");
    if (!/^(?!-)[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(domain)) {
      return json({ error: "That doesn't look like a domain — enter just the part after the @, like yourbusiness.com." }, 400);
    }
    const { data: cur, error: curErr } = await admin
      .from("client_settings").select("email_domain, resend_domain_id, internal_account")
      .eq("client_id", clientId).maybeSingle();
    if (curErr) return dbFail(req, clientId, "read your email sending settings", curErr);

    // Domains that are OURS. Connecting one would claim the sender identity the platform's
    // own mail rides on — csmsynergy.com most of all, since that is where the account
    // notifications and every fallback send come from. The internal account is exempt for
    // the obvious reason: those domains are its own, and it is the tenant that really does
    // connect them.
    const PLATFORM_APEXES = ["structurestudiosuite.com", "structurestudio.app", "csmsynergy.com"];
    if (!cur?.internal_account && PLATFORM_APEXES.some((apex) => domain === apex || domain.endsWith(`.${apex}`))) {
      return json({ error: "That domain belongs to StructureStudio — connect your own business domain instead." }, 400);
    }
    const fromLocalRaw = String(payload?.fromLocal ?? "").trim().toLowerCase();
    if (fromLocalRaw && !/^[a-z0-9._%+-]{1,64}$/.test(fromLocalRaw)) {
      return json({ error: "The from address can only contain letters, numbers and . _ % + - (just the part before the @)." }, 400);
    }
    const fromLocal = fromLocalRaw || "info";
    const fromName = String(payload?.fromName ?? "").trim().slice(0, 120) || null;

    // ── A CLAIM IS NOT OWNERSHIP UNTIL IT VERIFIES ────────────────────────────────────
    // The row is written the moment someone types a domain, and the partial unique index
    // (migration 107) then reserves it for that account whether or not they can prove they
    // control it. So an UNVERIFIED claim on a domain — mistyped, abandoned, or simply typed
    // by the wrong person — locked the rightful owner out with a permanent 409 that no
    // screen in the product can clear. What settles ownership is the DNS records, and only a
    // domain's real owner can publish those.
    //
    // So: a holder who has verified (now, or ever — a domain that later failed a re-check
    // still PROVED control once) keeps it and is never displaceable. A holder who never
    // verified is released, at the provider first and then in the row, and told why on their
    // own card. The 23505 catch below stays exactly as it was: it is the race backstop for
    // two accounts arriving between this read and that write, which this does not replace.
    const { data: holder, error: holderErr } = await admin
      .from("client_settings").select("client_id, email_domain_status, email_verified_at, resend_domain_id")
      .eq("email_domain", domain).neq("client_id", clientId).maybeSingle();
    if (holderErr) return dbFail(req, clientId, "check that domain", holderErr);
    if (holder && (holder.email_domain_status === "verified" || holder.email_verified_at)) {
      return json({ error: "That domain is already connected to another account." }, 409);
    }
    if (holder) {
      // ⚠️ DO NOT "RELEASE" ANOTHER TENANT'S UNVERIFIED CLAIM FROM HERE. The audit's own fix
      // for this (2026-09-06) deleted the holder's domain at Resend and reset seventeen columns
      // on their client_settings row, gated only on settings_email:edit - a grant every owner
      // and admin holds. That would let any admin of any tenant destroy another tenant's email
      // setup by typing their domain: a cross-tenant write this product has never allowed, and
      // worse than the squatting it was meant to cure. "Unverified" is not an abandoned claim
      // either - it is the normal state between connecting a domain and publishing the DNS, so
      // the victim is usually a builder who is halfway through setup.
      // Releasing a stale claim is an OPERATOR action. Refuse, and say who can help.
      return json({
        error: "That domain is already connected to another account. If it should be yours, " +
               "contact support and we'll release it.",
      }, 409);
    }

    let d: RsDomain;
    try {
      // Reconnect reuse: this tenant's same domain already exists on the provider —
      // re-read its records rather than erroring on a duplicate create.
      d = cur?.resend_domain_id && cur?.email_domain === domain
        ? await rsGetDomain(String(cur.resend_domain_id))
        : await rsCreateDomain(domain);
    } catch (e) {
      return rsFail(req, clientId, "connect that domain", e);
    }

    const dnsRecords = dnsRecordsOf(d);
    const { error: upErr } = await admin.from("client_settings").upsert({
      client_id: clientId,
      email_domain: domain,
      resend_domain_id: d.id,
      email_domain_status: "pending",
      email_dns_records: dnsRecords,
      email_from_local: fromLocal,
      email_from_name: fromName,
      email_verified_at: null,
      email_last_error: null,
      updated_at: new Date().toISOString(),
    }, { onConflict: "client_id" });
    if (upErr) {
      // 23505 = the partial unique index on email_domain (migration 107): another tenant
      // connected this domain between the pre-check above and this write.
      if ((upErr as { code?: string }).code === "23505") {
        return json({ error: "That domain is already connected to another account." }, 409);
      }
      return dbFail(req, clientId, "save your email domain", upErr);
    }
    return json({ ok: true, dnsRecords });
  }

  if (action === "email_verify_domain") {
    const { data: cur, error: curErr } = await admin
      .from("client_settings").select("resend_domain_id")
      .eq("client_id", clientId).maybeSingle();
    if (curErr) return dbFail(req, clientId, "read your email sending settings", curErr);
    if (!cur?.resend_domain_id) return json({ error: "Connect a domain first." }, 400);

    let d: RsDomain;
    try {
      d = await rsVerifyDomain(String(cur.resend_domain_id));
    } catch (e) {
      // Park an authored note on the card (the UI's failed/pending panel renders
      // lastError) — never provider text. Best-effort: the response already says it.
      await admin.from("client_settings").update({
        email_last_error: "The verification check couldn't run — try again in a few minutes.",
        updated_at: new Date().toISOString(),
      }).eq("client_id", clientId);
      return rsFail(req, clientId, "check your domain's DNS records", e);
    }

    // "Verified" is the domain-level status, never a per-record AND (resend.ts: DKIM alone leaks the provider's return
    // path into customer-visible headers). A check that simply finds the records absent
    // is NOT an error — the per-record flags refresh and the status stays pending.
    const verified = rsDomainVerified(d);
    const dnsRecords = dnsRecordsOf(d);
    // ⚠️ DO NOT COLLAPSE EVERY NON-VERIFIED STATE INTO "pending". Resend's domain enum is
    // not_started | pending | verified | failed | temporary_failure, and this used to map
    // all four failures to "pending" — so a domain Resend had GIVEN UP on displayed as
    // "waiting for the crawler" forever. That is the worst possible reading: the tenant
    // sits watching a spinner that will never resolve, and the operator has nothing to act
    // on. `failed` is a real column value (107's CHECK allows it), so say so, and carry the
    // provider's own word out in the response for support.
    const providerStatus = String(d.status || "");
    const givenUp = providerStatus === "failed" || providerStatus === "temporary_failure";
    const domainStatus = verified ? "verified" : givenUp ? "failed" : "pending";
    const { error: upErr } = await admin.from("client_settings").update({
      email_domain_status: domainStatus,
      email_dns_records: dnsRecords,
      email_verified_at: verified ? new Date().toISOString() : null,
      // Authored, never provider text — but it must name the state, because "pending" and
      // "we stopped checking" call for completely different actions from the tenant.
      email_last_error: givenUp
        ? (providerStatus === "temporary_failure"
          ? "Your domain passed before but failed a re-check. Confirm the DNS records below are still published, then check again."
          : "Your provider stopped checking this domain. Confirm every DNS record below is published exactly as shown, then check again — or disconnect and reconnect the domain to start over.")
        : null,
      updated_at: new Date().toISOString(),
    }).eq("client_id", clientId);
    if (upErr) return dbFail(req, clientId, "save your domain's verification state", upErr);
    return json({ ok: true, verified, domainStatus, providerStatus, dnsRecords });
  }

  if (action === "email_activate") {
    const enabled = payload?.enabled === true;
    const { data: cur, error: curErr } = await admin
      .from("client_settings").select("email_domain_status")
      .eq("client_id", clientId).maybeSingle();
    if (curErr) return dbFail(req, clientId, "read your email sending settings", curErr);
    // Enabling requires a VERIFIED domain — never auto-flipped by verify, and never
    // allowed before it, or estimates would send from a domain inboxes distrust.
    // Disabling is always allowed: it is the instant rollback to the GHL sender.
    if (enabled && cur?.email_domain_status !== "verified") {
      return json({ error: "Verify your domain's DNS records before turning this on." }, 409);
    }
    const { error: upErr } = await admin.from("client_settings").update({
      email_provider: enabled ? "resend" : "ghl",
      updated_at: new Date().toISOString(),
    }).eq("client_id", clientId);
    if (upErr) return dbFail(req, clientId, "save your email sending switch", upErr);
    return json({ ok: true, active: enabled });
  }

  if (action === "email_send_test") {
    const to = String(payload?.to ?? "").trim();
    if (!isEmail(to)) return json({ error: "Enter a valid email address to send the test to." }, 400);
    const { data: cur, error: curErr } = await admin
      .from("client_settings")
      .select("email_provider, email_domain_status, email_domain, email_from_local, business_name")
      .eq("client_id", clientId).maybeSingle();
    if (curErr) return dbFail(req, clientId, "read your email sending settings", curErr);
    if (cur?.email_domain_status !== "verified" || cur?.email_provider !== "resend") {
      return json({ error: "Verify your domain and turn sending on before sending a test email." }, 409);
    }
    const fromLocal = (typeof cur.email_from_local === "string" && cur.email_from_local.trim()) || "info";
    const businessName = String(cur.business_name ?? "").trim() || clientId;
    // sendTenantEmail owns the ledger row, the beta redirect and the dark guards — it
    // never throws; the verdict below is the whole outcome.
    const out = await sendTenantEmail(admin, clientId, {
      kind: "test",
      to,
      ...testEmail({ businessName, fromAddress: `${fromLocal}@${cur.email_domain}` }),
    });
    if (out.sent) return json({ ok: true, messageId: out.messageId });
    if (out.reason === "not_active") {
      // The tenant-side switches all say go, so the missing half is the platform's
      // (secrets unset) — the friendly not-ready sentence, never a 500.
      return json({ error: "Email sending isn't available yet — it's still being set up. Please try again later." }, 503);
    }
    return json({ error: `The test email didn't send${out.error ? ` (${out.error})` : ""}. Try again — if it keeps happening, tell CSM Synergy.` }, 502);
  }

  if (action === "email_disconnect") {
    const { data: cur, error: curErr } = await admin
      .from("client_settings").select("resend_domain_id, resend_inbound_domain_id")
      .eq("client_id", clientId).maybeSingle();
    if (curErr) return dbFail(req, clientId, "read your email sending settings", curErr);
    if (cur?.resend_domain_id) {
      // Best-effort on the provider side: whatever happens there, the tenant's OWN reset
      // below must land — a stuck provider must not trap a tenant on a domain they are
      // trying to leave. An orphaned provider domain is inert (nothing sends from it once
      // email_provider is back on 'ghl') and shows in the provider dashboard for cleanup.
      try {
        await rsDeleteDomain(String(cur.resend_domain_id));
      } catch (e) {
        logEdgeError({
          fn: "portal-settings", req, clientId, code: "email_disconnect_provider",
          message: `provider domain delete failed (id ${cur.resend_domain_id}): ${
            e instanceof ResendApiError ? `resend ${e.status}/${e.name_ || "unknown"}` : String((e as Error)?.message ?? e)
          }`,
        }).catch(() => {});
      }
    }
    // ── AND THE RECEIVING DOMAIN, WHICH USED TO BE LEFT BEHIND ────────────────────────
    // The write below clears BOTH halves locally (see the note on inbound_domain there), but
    // only the sending domain was ever deleted at the provider — so reply.<domain> stayed on
    // the shared account with receiving switched ON. Three consequences, none of them
    // visible from inside the product: a domain slot burned for good on an account whose cap
    // is what limits onboarding, a live mail sink still accepting replies to a builder who
    // has left, and a reconnect that cannot re-create the subdomain because it already
    // exists — leaving that tenant unable to turn replies back on at all.
    //
    // Its own try/catch and its own error code, deliberately: a failure on either delete
    // must not skip the other, and support needs to be able to tell which domain leaked.
    // The id is logged because the reset below is about to null it, and it is the only
    // handle the provider dashboard can be searched by afterwards.
    if (cur?.resend_inbound_domain_id) {
      try {
        await rsDeleteDomain(String(cur.resend_inbound_domain_id));
      } catch (e) {
        logEdgeError({
          fn: "portal-settings", req, clientId, code: "email_disconnect_inbound_provider",
          message: `provider inbound domain delete failed (id ${cur.resend_inbound_domain_id}): ${
            e instanceof ResendApiError ? `resend ${e.status}/${e.name_ || "unknown"}` : String((e as Error)?.message ?? e)
          }`,
        }).catch(() => {});
      }
    }
    // Back to the migration-107 defaults — the same shape a never-connected tenant has.
    const { error: upErr } = await admin.from("client_settings").update({
      email_domain: null,
      email_from_local: "info",
      email_from_name: null,
      email_provider: "ghl",
      resend_domain_id: null,
      email_domain_status: "not_configured",
      email_dns_records: null,
      email_verified_at: null,
      email_last_error: null,
      // ⚠️ TEAR INBOUND DOWN IN THE SAME WRITE. Receiving lives on a SUBDOMAIN of the
      // sending domain, so a tenant who disconnects has given up the whole domain — leaving
      // inbound_status='active' behind would keep sendTenantEmail stamping
      // d.<code>@reply.<domain> as Reply-To on a domain nobody is watching any more, and
      // every customer reply would vanish with no error on either side.
      inbound_domain: null,
      inbound_status: "off",
      inbound_dns_records: null,
      resend_inbound_domain_id: null,
      inbound_verified_at: null,
      inbound_last_error: null,
      updated_at: new Date().toISOString(),
    }).eq("client_id", clientId);
    if (upErr) return dbFail(req, clientId, "disconnect your email domain", upErr);
    return json({ ok: true });
  }

  // ── Receiving replies ────────────────────────────────────────────────────────────────
  //
  // Ahsan, 2026-08-26: "if Junior Barns connects his domain, he should be able to send AND
  // receive emails in there."
  //
  // ⚠️ ALWAYS A SUBDOMAIN, NEVER THE APEX. The builder already receives their real business
  // mail at @jrbarns.com — pointing that MX at us would take over their company inbox. The
  // subdomain is derived HERE from the verified sending domain rather than accepted from the
  // request: a tenant-supplied inbound domain would let someone route a customer's replies
  // at a host they do not own, and it is also the field a confused builder would most likely
  // fill in with their apex.
  if (action === "email_inbound_connect") {
    const { data: cur, error: curErr } = await admin
      .from("client_settings")
      .select("email_domain, email_domain_status, inbound_domain, resend_inbound_domain_id")
      .eq("client_id", clientId).maybeSingle();
    if (curErr) return dbFail(req, clientId, "read your email settings", curErr);

    // Sending must be verified first. Receiving on a domain we have not proved the tenant
    // controls would publish an MX for someone else's host.
    const sendingDomain = String(cur?.email_domain ?? "").trim().toLowerCase();
    if (!sendingDomain || cur?.email_domain_status !== "verified") {
      return json({ error: "Verify your sending domain first — replies use a subdomain of it." }, 400);
    }
    const inboundDomain = `reply.${sendingDomain}`;

    // Another tenant holding this exact subdomain means two builders would receive each
    // other's replies. The partial unique index (migration 137) is the race-proof backstop;
    // this is the readable refusal.
    const { data: holder, error: holderErr } = await admin
      .from("client_settings").select("client_id")
      .eq("inbound_domain", inboundDomain).neq("client_id", clientId).maybeSingle();
    if (holderErr) return dbFail(req, clientId, "check that reply address", holderErr);
    if (holder) return json({ error: "That reply address is already in use by another account." }, 409);

    let d: RsDomain;
    try {
      d = cur?.resend_inbound_domain_id && cur?.inbound_domain === inboundDomain
        ? await rsGetDomain(String(cur.resend_inbound_domain_id))
        : await rsCreateDomain(inboundDomain, { receiving: true });
    } catch (e) {
      return rsFail(req, clientId, "set up your reply address", e);
    }

    // FAIL LOUDLY rather than inventing a hostname. If the provider did not hand back an MX
    // there is nothing honest to show a builder, and a guessed inbound host is a mail path
    // that bounces with no error anywhere. Better a clear refusal than a table of fiction.
    const mx = rsInboundRecords(d);
    if (mx.length === 0) {
      await logEdgeError({
        fn: "portal-settings", req, clientId, code: "inbound_no_mx_record",
        message: "Resend returned no MX record for a receiving domain; the DNS table cannot be rendered.",
        context: { inboundDomain, domainId: d.id, recordCount: d.records.length },
      });
      return json({ error: "We couldn't get the mail record for your reply address. Tell CSM Synergy — nothing is broken on your side." }, 502);
    }

    const { error: upErr } = await admin.from("client_settings").update({
      inbound_domain: inboundDomain,
      resend_inbound_domain_id: d.id,
      // 'pending' until the MX actually resolves. It must NOT be 'active' here: the moment
      // it is, every outbound email starts advertising a reply address whose MX does not
      // exist yet, and the customer's reply bounces back at the customer.
      inbound_status: "pending",
      inbound_dns_records: mx,
      inbound_verified_at: null,
      inbound_last_error: null,
      updated_at: new Date().toISOString(),
    }).eq("client_id", clientId);
    if (upErr) return dbFail(req, clientId, "save your reply address", upErr);
    return json({ ok: true, inboundDomain, dnsRecords: mx });
  }

  if (action === "email_inbound_verify") {
    const { data: cur, error: curErr } = await admin
      .from("client_settings").select("inbound_domain, resend_inbound_domain_id")
      .eq("client_id", clientId).maybeSingle();
    if (curErr) return dbFail(req, clientId, "read your reply address", curErr);
    if (!cur?.resend_inbound_domain_id) return json({ error: "Set up your reply address first." }, 400);

    let d: RsDomain;
    try {
      d = await rsVerifyDomain(String(cur.resend_inbound_domain_id));
    } catch (e) {
      return rsFail(req, clientId, "check your reply address", e);
    }

    // ⚠️ rsInboundReady, NOT rsDomainVerified. The domain-level status only turns "verified"
    // once every record passes, including DKIM/SPF rows a receiving-only subdomain has no
    // reason to hold — so gating on it would strand a tenant whose inbound MX resolves
    // perfectly on "pending" forever, staring at a correct DNS table. Ask instead whether
    // receiving is switched on and the receiving record itself has been seen.
    const ok = rsInboundReady(d);
    const mx = rsInboundRecords(d);
    const { error: upErr } = await admin.from("client_settings").update({
      inbound_status: ok ? "active" : "pending",
      // Keep the previous snapshot if a verify round-trip returned none, rather than blanking
      // the table the builder is mid-way through copying.
      ...(mx.length ? { inbound_dns_records: mx } : {}),
      inbound_verified_at: ok ? new Date().toISOString() : null,
      inbound_last_error: ok ? null : (rsReceivingEnabled(d) ? null : "Receiving is not switched on for this domain yet."),
      updated_at: new Date().toISOString(),
    }).eq("client_id", clientId);
    if (upErr) return dbFail(req, clientId, "save your reply address", upErr);
    return json({ ok: true, verified: ok, inboundStatus: ok ? "active" : "pending", dnsRecords: mx });
  }

  if (action === "email_inbound_disconnect") {
    const { data: cur, error: curErr } = await admin
      .from("client_settings").select("resend_inbound_domain_id")
      .eq("client_id", clientId).maybeSingle();
    if (curErr) return dbFail(req, clientId, "read your reply address", curErr);
    if (cur?.resend_inbound_domain_id) {
      // Best-effort, same posture as email_disconnect: a stuck provider must not trap a
      // tenant on a reply address they are trying to switch off.
      try {
        await rsDeleteDomain(String(cur.resend_inbound_domain_id));
      } catch (e) {
        logEdgeError({
          fn: "portal-settings", req, clientId, code: "inbound_disconnect_provider",
          message: `provider inbound domain delete failed (id ${cur.resend_inbound_domain_id}): ${
            e instanceof ResendApiError ? `resend ${e.status}/${e.name_ || "unknown"}` : String((e as Error)?.message ?? e)
          }`,
        }).catch(() => {});
      }
    }
    const { error: upErr } = await admin.from("client_settings").update({
      inbound_domain: null,
      inbound_status: "off",
      inbound_dns_records: null,
      resend_inbound_domain_id: null,
      inbound_verified_at: null,
      inbound_last_error: null,
      updated_at: new Date().toISOString(),
    }).eq("client_id", clientId);
    if (upErr) return dbFail(req, clientId, "turn off your reply address", upErr);
    return json({ ok: true });
  }

  // ── Send invoice for an ACCEPTED design (Contacts tab). Owner/admin only (it is a
  // mutation, so the role gate above already applies). Converts the design's GHL
  // estimate to an invoice (marking the estimate invoiced) and emails it to the
  // customer — verified live against the LeadConnector API 2026-07-25.
  //
  // The convert is IRREVERSIBLE and the email is a separate call that can fail, so the
  // whole action is serialised through the `invoice_sends` ledger (migration 052):
  //   * the PK insert is the concurrency claim — a racing request cannot convert twice;
  //   * a 'created' row means the invoice exists but was never emailed, so a retry
  //     RE-SENDS the stored invoice id instead of converting again (no orphaned invoice);
  //   * the userId the send endpoint requires is resolved BEFORE converting, so a missing
  //     user fails fast instead of after the estimate has already been flipped.
  // (Restored here 2026-08-07: this note had been stranded ~330 lines up, above the
  // unrelated qbo_pending action — the file's most consequential invariant documented
  // nowhere near the code that implements it.)
  // ── resend_quote_email: re-send the SS quote email (migration 122) ──────────────────
  // The quote already exists (number allocated, PDF built by submit-estimate 9-ALT); this
  // just re-sends the branded email. No allocation, no conversion, no ledger claim — the
  // worst a retry can do is email the design's own customer twice. Success re-stamps
  // ss_quote_sent_at; a failure reports {sent:false, reason} so the rep reaches for Print
  // or Copy-link instead (Carolyn 2026-08-23: email absence never blocks the quote).
  //
  // THE SEND ITSELF IS sendQuoteEmail, shared with restampQuoteTax below (2026-09-17): a quote
  // re-priced while the customer holds it is re-sent through exactly this code, so the two can never
  // disagree about what a quote email says. It reads the design fresh, so a caller that has
  // just re-priced it sends the new total. It checks no row scope — every caller does that
  // first. `refused` carries this action's own refusals, unchanged. `noEmail` is for the
  // re-stamp's own wording only; resend_quote_email answers with `sent` and `reason` as before.
  const sendQuoteEmail = async (
    shortCode: string,
  ): Promise<{ refused: Response } | { sent: boolean; reason: string | null; noEmail?: true }> => {
    const { data: d, error: dErr } = await admin
      .from("designs")
      .select("short_code, contact, selections, ss_quote_number, ss_quote_pdf_url, image_url, estimate_lines")
      .eq("client_id", clientId).eq("short_code", shortCode).maybeSingle();
    if (dErr) return { refused: dbFail(req, clientId, "find that design", dErr) };
    if (!d) return { refused: json({ error: "Design not found." }, 404) };
    if (!d.ss_quote_number) return { refused: json({ error: "This design has no StructureStudio quote yet — submit it from the designer first." }, 400) };

    const { data: cs, error: csErr } = await admin
      .from("client_settings")
      .select("invoice_in_ghl, business_name, business_phone, business_website, business_logo_url, quote_terms")
      .eq("client_id", clientId).maybeSingle();
    if (csErr) return { refused: dbFail(req, clientId, "read your settings", csErr) };
    if (!cs || cs.invoice_in_ghl !== false) {
      return { refused: json({ error: "This account quotes through the CRM — re-send it from there." }, 400) };
    }

    const to = String(d?.contact?.email || "").trim();
    if (!to) return { sent: false, reason: "no email address on this design", noEmail: true };

    const total = totalFromSnapshot(d.estimate_lines);
    const sel = d.selections || {};
    const content = estimateEmail({
      businessName: cs.business_name || clientId,
      logoUrl: cs.business_logo_url || null,
      phone: cs.business_phone || null,
      website: cs.business_website || null,
      estimateNumber: String(d.ss_quote_number),
      total: total == null ? "" : total,
      styleLabel: sel.style || null,
      sizeLabel: sel.size || null,
      estimateUrl: myQuotesUrl(clientId, req),
      pdfUrl: d.image_url || null,
      formalPdfUrl: d.ss_quote_pdf_url || null,
      quoteTerms: cs.quote_terms || null,
      docWord: "quote",
    });
    const outcome = await sendTenantEmail(admin, clientId, {
      kind: "estimate",
      shortCode,
      to,
      subject: content.subject,
      html: content.html,
      text: content.text,
    });
    if (outcome.sent) {
      await admin.from("designs")
        .update({ ss_quote_sent_at: new Date().toISOString() })
        .eq("client_id", clientId).eq("short_code", shortCode);
    }
    return { sent: outcome.sent, reason: outcome.sent ? null : (outcome.reason || "failed") };
  };

  if (action === "resend_quote_email") {
    const shortCode = String(payload?.shortCode ?? "").trim();
    if (!shortCode) return json({ error: "shortCode is required." }, 400);
    // ROW SCOPE (207). A rep on contacts:'own' may hold designs:edit / orders:edit and
    // still not be allowed near THIS customer's building. The gate above decides what
    // KIND of thing they may do; this decides which rows. Placed before the design is
    // even read, so a refusal costs nothing and cannot leak timing.
    { const refused = await refuseUnlessDesignVisible(shortCode); if (refused) return refused; }

    const out = await sendQuoteEmail(shortCode);
    if ("refused" in out) return out.refused;
    return json({ ok: true, sent: out.sent, reason: out.reason });
  }

  // ── Re-pricing an issued quote's tax (2026-09-17) ───────────────────────────────────
  //
  // Refuse a quote the customer has agreed to, or that has an order. Past acceptance a new
  // total is an amendment — a change order the customer signs — never a silent re-stamp; the
  // order's money columns are written once, guarded `.is("total_cents", null)`, so a later
  // re-price would never reach them and the PDF, the order and the commission base would
  // disagree. The agreement test is migration 197's (accepted_at, or the status ladder), and
  // the order read fails CLOSED: an unreadable orders table is not "no order".
  //
  // A RECORDED QUOTE ACCEPTANCE IS AGREEMENT TOO, even while designs.accepted_at is still null
  // (review, 2026-09-17). customer-accept records the acceptance first and promotes the design
  // after it, so for a moment a signed quote reads unsigned here, and a promote that failed
  // leaves it reading unsigned for good. This read fails CLOSED like the order read. It narrows
  // the accept race but cannot close it (a check, then a write): what closes it is
  // customer-accept's compare-and-swap promote, which refuses the customer and withdraws the
  // acceptance when a re-price lands first.
  const agreedRefusal = () => json({
    error: "The customer has already accepted this quote, so its tax can't be changed here. A change to a signed order goes through a change order.",
    reason: "accepted",
  }, 409);
  // deno-lint-ignore no-explicit-any
  const refuseIfAgreed = async (d: any): Promise<Response | null> => {
    if (isAgreedDesign(d)) return agreedRefusal();
    const { data: acc, error: accErr } = await admin.from("design_acceptances").select("id")
      .eq("client_id", clientId).eq("short_code", String(d.short_code)).eq("subject", "quote").limit(1);
    if (accErr) return dbFail(req, clientId, "check whether this quote has been accepted", accErr);
    if ((acc ?? []).length) return agreedRefusal();
    const { data: ord, error: ordErr } = await admin.from("orders").select("id")
      .eq("client_id", clientId).eq("short_code", String(d.short_code)).limit(1);
    if (ordErr) return dbFail(req, clientId, "check whether this quote has an order", ordErr);
    if ((ord ?? []).length) {
      return json({
        error: "This quote already has an order, so its tax can't be changed here.",
        reason: "ordered",
      }, 409);
    }
    return null;
  };

  /**
   * ── restampQuoteTax ── put a new `tax` object onto an ISSUED quote, and everything that has
   * to follow from it. ONE helper for every caller that re-prices a quote's tax outside a
   * submit (the sales-location change here; the verify button next), so the guards cannot be
   * copied into one caller and forgotten in the other.
   *
   * `d` is the design as the caller read it (RESTAMP_DESIGN_COLUMNS) — the snapshot `tax` was
   * priced against. `tax` is the complete object (taxChain's stampTax). `alsoSet` rides in the
   * SAME update, so a column that belongs with the new tax (sales_location_id) is never written
   * without it.
   *
   * In order — every refusal comes before the first write, so a refused call changes nothing:
   *   1. re-read the row: the caller's read may be seconds old (a lookup sits between them);
   *   2. refuse an agreed or ordered quote (refuseIfAgreed);
   *   3. refuse when the lines moved since the caller priced them (a resubmit landed): the new
   *      tax was computed for lines the quote no longer has — 409 `changed`;
   *   4. restampPlan: no issued quote → 409 `no_quote`; a quote the customer holds
   *      (quoteInCustomerHands: emailed, or numbered and past draft, since a texted or printed
   *      quote never stamps ss_quote_sent_at) whose total would move, without confirmResend →
   *      409 `quote_sent` naming both totals;
   *   5. write estimate_lines + total_cents (+ alsoSet) as a compare-and-swap on updated_at
   *      (designs_set_updated_at bumps it on every update) and accepted_at still null, checked:
   *      no row means somebody else wrote first → 409 `changed`;
   *   5b. `afterWrite`, when given — the one thing that must follow the write immediately and
   *      only if it landed (verify_tax's charge: a document is written before it is paid for,
   *      and a slow PDF or email must not stand between the two). Awaited, but it cannot
   *      refuse: the quote is already written, and a throw is swallowed;
   *   6. regenerate the quote PDF, best-effort (regenerateQuotePdf's own contract);
   *   6b. re-read the lines, and when a later writer has moved them, print the stored ones and
   *      send nothing (quoteWriteRace.ts: the document always ends up printing the final row);
   *   7. when the customer holds the quote and its total moved, email it again through
   *      sendQuoteEmail, but only when step 6 rebuilt the PDF (restampResend). The email
   *      links the PDF's fixed path, so a failed rebuild would send the new total next to a
   *      PDF that still prints the old one. Email is the only re-send: nothing here texts.
   *      A skipped or failed send does not undo the re-price. The rep is told
   *      (`resent: false`, and a `resendReason` sentence saying the customer has not been sent
   *      the new total, restampSendOutcome) — a customer with no email address is theirs to
   *      tell.
   * It never looks anything up and never charges: pricing is the caller's business.
   *
   * THE RESUBMIT WINDOW IS CLOSED FROM BOTH SIDES (review, 2026-09-17). submit-estimate's
   * persist used to be unguarded and to follow its own PDF upload and email, so a re-stamp that
   * landed while a resubmit was running was overwritten by the older tax (a verified rate paid
   * for and silently dropped), and whichever PDF uploaded last decided what the document printed.
   * The persist is now a compare-and-swap that refuses the resubmit, before it uploads or emails
   * anything, when the stored tax is not the one it priced from; the compare-and-swap below
   * catches a resubmit that persisted first; and each side uploads only after its own write and
   * then checks the stored lines (6b). quoteWriteRace.ts has the rule and why it is enough.
   */
  const restampQuoteTax = async (
    // deno-lint-ignore no-explicit-any
    d: any,
    tax: Record<string, unknown>,
    opts: { confirmResend: boolean; alsoSet?: Record<string, unknown>; where: string; afterWrite?: () => Promise<void> },
  ): Promise<
    | { ok: false; response: Response }
    | {
      ok: true;
      tax: Record<string, unknown>;
      totalCents: number;
      previousTotalCents: number;
      resent: boolean;
      resendReason: string | null;
      quotePdfUrl: string | null;
    }
  > => {
    const shortCode = String(d?.short_code ?? "");
    const { data: fresh, error: freshErr } = await admin.from("designs").select(RESTAMP_DESIGN_COLUMNS)
      .eq("client_id", clientId).eq("short_code", shortCode).maybeSingle();
    if (freshErr) return { ok: false, response: dbFail(req, clientId, opts.where, freshErr) };
    if (!fresh) return { ok: false, response: json({ error: "Design not found.", reason: "not_found" }, 404) };

    const agreed = await refuseIfAgreed(fresh);
    if (agreed) return { ok: false, response: agreed };

    const changedUnderneath = () => json({
      error: "This quote changed while you were working on it. Reload it and try again.",
      reason: "changed",
    }, 409);
    // jsonb comes back key-normalised, so two reads of the same stored value stringify alike.
    if (JSON.stringify(fresh.estimate_lines ?? null) !== JSON.stringify(d?.estimate_lines ?? null)) {
      return { ok: false, response: changedUnderneath() };
    }

    const plan = restampPlan({
      snap: fresh.estimate_lines, tax, inCustomerHands: quoteInCustomerHands(fresh), confirmResend: opts.confirmResend,
    });
    if (!plan.ok) {
      if (plan.reason === "no_quote") {
        return {
          ok: false,
          response: json({ error: "This design has no quote yet — issue the quote first.", reason: "no_quote" }, 409),
        };
      }
      return {
        ok: false,
        response: json({
          error: "The customer already has this quote, and its total would change. Confirm to update it. We email them the new total, or tell you to let them know if we can't.",
          reason: "quote_sent",
          quoteNumber: fresh.ss_quote_number ?? null,
          totalCents: plan.previousTotalCents,
          newTotalCents: plan.totalCents,
        }, 409),
      };
    }

    let write = admin.from("designs")
      .update({ ...(opts.alsoSet ?? {}), estimate_lines: plan.snap, total_cents: plan.totalCents, updated_at: new Date().toISOString() })
      .eq("client_id", clientId).eq("short_code", shortCode).is("accepted_at", null);
    write = fresh.updated_at ? write.eq("updated_at", fresh.updated_at) : write.is("updated_at", null);
    // estimate_lines comes back as the database stored it: step 6b compares it with a fresh read.
    const { data: wrote, error: writeErr } = await write.select("short_code, estimate_lines");
    if (writeErr) return { ok: false, response: dbFail(req, clientId, opts.where, writeErr) };
    if (!Array.isArray(wrote) || wrote.length !== 1) return { ok: false, response: changedUnderneath() };

    if (opts.afterWrite) {
      try {
        await opts.afterWrite();
      } catch (_e) {
        // The quote is written; whatever followed it reports its own failure.
      }
    }

    const quotePdfUrl = fresh.ss_quote_number
      ? await regenerateQuotePdf(admin, req, clientId, shortCode, {
        quoteNumber: String(fresh.ss_quote_number), snap: plan.snap, planUrl: fresh.image_url,
      })
      : null;

    // 6b. THE DOCUMENT FOLLOWS THE ROW (review, 2026-09-17; the rule is quoteWriteRace.ts's). The
    // PDF path is shared with submit-estimate, and a resubmit that persisted after this write can
    // have uploaded its PDF BEFORE the regenerate above, which then replaced it with lines the
    // quote no longer has. So re-read the lines after uploading, and when they are not the ones
    // printed, print the stored ones. That resubmit emails the customer its own total, so this
    // re-stamp's total, already out of date, is not sent (restampResend's movedOn).
    let movedOn = false;
    if (quotePdfUrl) {
      let printed: unknown = wrote[0].estimate_lines;
      for (let pass = 1; pass <= 2; pass++) {
        const { data: after, error: afterErr } = await admin.from("designs")
          .select("estimate_lines, ss_quote_number, image_url")
          .eq("client_id", clientId).eq("short_code", shortCode).maybeSingle();
        if (afterErr || !after || !quotePdfStale(printed, after.estimate_lines)) break;
        movedOn = true;
        const rebuilt = await regenerateQuotePdf(admin, req, clientId, shortCode, {
          quoteNumber: String(after.ss_quote_number ?? fresh.ss_quote_number), snap: after.estimate_lines, planUrl: after.image_url,
        });
        if (!rebuilt) break;
        printed = after.estimate_lines;
      }
    }

    let resent = false;
    const gate = restampResend({ resend: plan.resend, quoteNumber: fresh.ss_quote_number, quotePdfUrl, movedOn });
    let resendReason: string | null = gate.send ? null : gate.reason;
    if (gate.send) {
      const sent = await sendQuoteEmail(shortCode);
      ({ resent, resendReason } = restampSendOutcome("refused" in sent ? "refused" : sent));
    }
    return {
      ok: true, tax, totalCents: plan.totalCents, previousTotalCents: plan.previousTotalCents,
      resent, resendReason, quotePdfUrl,
    };
  };

  // ── set_design_sales_location: which lot a quote was sold from (migration 245) ──────
  //
  // Staff pick it; a shopper never does (this function requires a signed-in member). The
  // location decides the quote's FREE default rate (_shared/taxChain.ts), so picking one on an
  // issued quote re-prices it here and now rather than at the next resubmit — a rep who moves a
  // quote to the Macon lot expects the Macon rate on the document they are looking at.
  //   - a VERIFIED rate on the quote is left exactly as it is: it was bought for the delivery
  //     address, and where the building was sold does not change what that address owes;
  //   - no issued quote, or a tenant whose paperwork comes from the CRM: the location is only
  //     recorded, and the next submit prices from it;
  //   - otherwise the chain without the home lot (clearing the location means "no lot", and
  //     borrowing the rep's own lot would put one straight back): the location's rate, else the
  //     company rate, else refuse. allowLookup stays FALSE — this can never make a paid call.
  // The location must be this tenant's and active; the composite foreign key (245) enforces the
  // tenant again in the database.
  if (action === "set_design_sales_location") {
    const parsed = parseSetSalesLocation(payload);
    if (!parsed.ok) return json({ error: parsed.error, reason: parsed.reason }, parsed.status);
    const { shortCode, locationId, confirmResend } = parsed.value;
    // ROW SCOPE first, before the design is read — the same placement as resend_quote_email.
    { const refused = await refuseUnlessDesignVisible(shortCode); if (refused) return refused; }

    const { data: d, error: dErr } = await admin.from("designs")
      .select(`${RESTAMP_DESIGN_COLUMNS}, sales_location_id, contact`)
      .eq("client_id", clientId).eq("short_code", shortCode).maybeSingle();
    if (dErr) return dbFail(req, clientId, "find that design", dErr);
    if (!d) return json({ error: "Design not found.", reason: "not_found" }, 404);
    { const agreed = await refuseIfAgreed(d); if (agreed) return agreed; }

    let location: TaxLocation | null = null;
    if (locationId) {
      const { data: lot, error: lotErr } = await admin.from("builder_locations").select(TAX_LOCATION_COLUMNS)
        .eq("client_id", clientId).eq("id", locationId).maybeSingle();
      if (lotErr) return dbFail(req, clientId, "load that location", lotErr);
      // Missing, another tenant's, or inactive: one answer for all three.
      location = taxLocationFrom(lot, clientId);
      if (!location) return json({ error: "Location not found.", reason: "location_not_found" }, 404);
    }

    const { data: cs, error: csErr } = await admin.from("client_settings")
      .select("invoice_in_ghl, ss_tax_rate, ss_tax_label").eq("client_id", clientId).maybeSingle();
    if (csErr) return dbFail(req, clientId, "read your sales tax rate", csErr);

    // deno-lint-ignore no-explicit-any
    const snap: any = d.estimate_lines;
    const storedTax = snap?.tax ?? null;
    const pools = subtotalsFromSnapshot(snap);
    const reprice = cs?.invoice_in_ghl === false && !!storedTax && typeof storedTax === "object" &&
      !isVerifiedTax(storedTax) && !!pools;

    if (!reprice) {
      const { data: wrote, error: wErr } = await admin.from("designs")
        .update({ sales_location_id: locationId, updated_at: new Date().toISOString() })
        .eq("client_id", clientId).eq("short_code", shortCode).is("accepted_at", null)
        .select("short_code");
      if (wErr) return dbFail(req, clientId, "set this quote's sales location", wErr);
      if (!Array.isArray(wrote) || wrote.length !== 1) {
        return json({ error: "This quote changed while you were working on it. Reload it and try again.", reason: "changed" }, 409);
      }
      await audit("portal_set_design_sales_location", 1, `design=${shortCode} location=${locationId ?? "none"} repriced=no`);
      return json({
        ok: true, salesLocationId: locationId, tax: storedTax, totalCents: designTotalCents(snap) ?? d.total_cents ?? null,
        resent: false,
      });
    }

    const choice = chooseDefaultRate({
      salesLocationId: locationId, location, homeLot: null,
      companyRate: cs?.ss_tax_rate, companyLabel: cs?.ss_tax_label ?? null,
    });
    if (!choice) {
      return json({
        error: "This account has no sales tax rate set, so this quote can't be re-priced. Add a rate to the location, or a company rate in Settings → CRM Connection → Quotes & Invoices (enter 0% if you don't collect sales tax).",
        reason: "no_tax_rate",
      }, 400);
    }
    const addr = addressFrom(d.contact);
    // allowLookup stays FALSE: only the chosen default comes back, as source "fallback".
    const resolved = await resolveRate(addr, choice.rate, { allowLookup: false });
    const tax = stampTax({ pools: pools!, resolved, choice, address: addr });

    const out = await restampQuoteTax(d, tax, {
      confirmResend, alsoSet: { sales_location_id: locationId }, where: "set this quote's sales location",
    });
    if (!out.ok) return out.response;
    await audit("portal_set_design_sales_location", 1,
      `design=${shortCode} location=${locationId ?? "none"} total=${out.previousTotalCents}->${out.totalCents} resent=${out.resent}`);
    return json({
      ok: true, salesLocationId: locationId, tax: out.tax, totalCents: out.totalCents,
      previousTotalCents: out.previousTotalCents, resent: out.resent, resendReason: out.resendReason,
      quotePdfUrl: out.quotePdfUrl,
    });
  }

  // ── verify_tax: a PAID rate lookup for one issued quote, pressed on purpose (2026-09-17) ──
  //
  // The only estimate-time path allowed to call Avalara. Every submit, resubmit, change order and
  // location change stamps a free default (taxChain.ts); this is how a rate for the delivery
  // address gets onto a quote, and it costs a lookup the account is billed for. So everything
  // that can refuse does so BEFORE the ledger row, and nothing about the quote changes unless a
  // rate came back:
  //   0. row scope, first — a rep narrowed to their own customers learns nothing about this code;
  //   1. the tenant's switch (tax_lookup_enabled), StructureStudio paperwork, credentials;
  //   2. an accepted or ordered quote: a new total there is a change order, never a re-stamp;
  //   3. no issued quote → "issue the quote first"; 4. no usable state + ZIP;
  //   5. an operator in view-as: confirmVerify, and a STRICT audit row (no row, no spend);
  //   6. a quote the customer already holds (emailed, texted or printed: quoteInCustomerHands):
  //      confirmResend, asked now because after the lookup the call is paid;
  //   7-9. paidLookup: the claim (the daily cap, the per-minute cap and the ledger row in one
  //      locked database step, failing closed), the request, the row closed;
  //   on failure: the quote is untouched. A verified rate the builder paid for earlier is never
  //      replaced by a fallback because the service was down this time;
  //   10. restampQuoteTax writes estimate_lines + total_cents, checked, and only then
  //   11. the charge, keyed on the ledger row (disarmed meters make it a no-op), then
  //   12. the PDF, and an email re-send when the total the customer holds moved.
  // A write refused after the lookup (a resubmit landed, the customer accepted) returns that
  // refusal and charges nothing: the call was made and is on the ledger, and nobody is billed for
  // a rate that never reached a document.
  if (action === "verify_tax") {
    const parsed = parseVerifyTax(payload);
    if (!parsed.ok) return json(parsed.refusal.body, parsed.refusal.status);
    const { shortCode, confirmResend, confirmVerify } = parsed.value;
    { const refused = await refuseUnlessDesignVisible(shortCode); if (refused) return refused; }

    const { data: cs, error: csErr } = await admin.from("client_settings")
      .select("invoice_in_ghl, tax_lookup_enabled, ss_tax_label").eq("client_id", clientId).maybeSingle();
    if (csErr) return dbFail(req, clientId, "read your tax settings", csErr);
    {
      const off = lookupSwitchRefusal({
        lookupEnabled: cs?.tax_lookup_enabled === true, ssMode: cs?.invoice_in_ghl === false, configured: avalaraConfigured(),
      });
      if (off) return json(off.body, off.status);
    }

    const { data: d, error: dErr } = await admin.from("designs")
      .select(`${RESTAMP_DESIGN_COLUMNS}, contact`)
      .eq("client_id", clientId).eq("short_code", shortCode).maybeSingle();
    if (dErr) return dbFail(req, clientId, "find that design", dErr);
    if (!d) return json({ error: "Design not found.", reason: "not_found" }, 404);
    { const agreed = await refuseIfAgreed(d); if (agreed) return agreed; }

    const address = addressFrom(d.contact);
    {
      const r = verifyQuoteRefusal({ snap: d.estimate_lines, address, operator: !!operator, confirmVerify });
      if (r) return json(r.body, r.status);
    }
    if (operator) {
      try {
        await auditStrict("operator_verify_tax_attempt", null, `short_code=${shortCode}`);
      } catch (e) {
        return json({ error: (e as Error).message, reason: "audit_unavailable" }, 503);
      }
    }
    {
      const r = quoteSentRefusal({
        inCustomerHands: quoteInCustomerHands(d), confirmResend, quoteNumber: d.ss_quote_number,
        totalCents: designTotalCents(d.estimate_lines),
      });
      if (r) return json(r.body, r.status);
    }

    // deno-lint-ignore no-explicit-any
    const storedTax: any = (d.estimate_lines as any)?.tax ?? null;
    const lookup = await paidLookup(admin, {
      clientId, kind: "verify", shortCode, address, fallbackRate: storedTax?.rate,
      actorUserId: userId ?? null, operator: !!operator,
    });
    if (lookup.lookupId && !lookup.ledgerClosed) {
      logEdgeError({
        fn: "portal-settings", req, clientId, code: "tax_lookup_unclosed",
        message: `verify_tax: the ledger row for ${shortCode} could not be closed`,
        context: { lookupId: lookup.lookupId },
      }).catch(() => {});
    }
    if (!lookup.ok) {
      await audit("portal_verify_tax", 0, `design=${shortCode} outcome=${lookup.failure} lookup=${lookup.lookupId ?? "none"}`);
      const r = verifyLookupRefusal(lookup.failure);
      return json(r.body, r.status);
    }

    const tax = verifiedTax({ snap: d.estimate_lines, lookup, companyLabel: cs?.ss_tax_label, address });
    // verifyQuoteRefusal already refused a snapshot with no pools; this is the type's null.
    if (!tax) return json({ error: "This design has no quote yet — issue the quote first, then verify its tax.", reason: "no_quote" }, 409);

    let charge: Awaited<ReturnType<typeof chargeLookup>> = { charged: false, reason: "no_rate" };
    const out = await restampQuoteTax(d, tax, {
      confirmResend,
      where: "save the verified tax rate",
      afterWrite: async () => {
        charge = await chargeLookup(admin, lookup, {
          clientId, kind: "tax_lookup", refType: "design", refId: shortCode,
          memo: `Verified sales tax rate${lookup.jurisdiction ? ` — ${lookup.jurisdiction}` : ""}`,
          actorUserId: userId ?? null,
        });
        if (!charge.charged && charge.reason === "error") {
          logEdgeError({
            fn: "portal-settings", req, clientId, code: "tax_meter",
            message: `tax_lookup charge failed for verified tax on ${shortCode}`,
            context: { lookupId: lookup.lookupId },
          }).catch(() => {});
        }
      },
    });
    if (!out.ok) {
      await audit("portal_verify_tax", 0, `design=${shortCode} outcome=ok written=no lookup=${lookup.lookupId}`);
      return out.response;
    }
    await audit("portal_verify_tax", 1,
      `design=${shortCode} lookup=${lookup.lookupId} total=${out.previousTotalCents}->${out.totalCents} resent=${out.resent} charged=${charge.charged}`);
    return json({
      ok: true, tax: out.tax, totalCents: out.totalCents, previousTotalCents: out.previousTotalCents,
      resent: out.resent, resendReason: out.resendReason, quotePdfUrl: out.quotePdfUrl, charged: charge.charged,
    });
  }

  // ── send_change_order: email a pending change order to the customer (migration 126) ──
  // The CO row already exists (raised by the SS resubmit path, or by the order card's
  // form); this only delivers the request-for-signature email. Idempotent — re-sending is
  // a duplicate email at worst, so it doubles as the "Resend" button.
  // THE AMENDMENT GATE (migration 210).
  // May this order be changed at all, and at what price? The SAME function the
  // change_orders guard trigger asks on every insert, so the button, the document and the
  // database can never answer differently -- three copies of this rule would drift, and the
  // one that drifted would be the one that let a locked order through.
  //
  // It never raises and fails OPEN by design (see 210); a read failure here therefore
  // reports open rather than locking a builder out of their own order.
  const amendmentGate = async (shortCode: string): Promise<Record<string, unknown>> => {
    const { data, error } = await admin.rpc("order_amendment_gate", {
      p_client_id: clientId, p_short_code: shortCode,
    });
    if (error || !data) {
      return { signed: false, open: true, authority: "free_window", unlock_id: null,
               fee_cents: 0, fee_taxable: false, reason: "" };
    }
    return data as Record<string, unknown>;
  };

  // The person's own name, for the evidence rows below. Denormalised at write time on
  // purpose -- an unlock has to still read correctly after the person is renamed or gone,
  // which is 178's argument for recorded_by_name and 126's for verbal_rep_name.
  const callerName = async (): Promise<string | null> => {
    if (!userId) return null;
    const { data } = await admin.from("client_users")
      .select("full_name").eq("user_id", userId).maybeSingle();
    const n = String(data?.full_name ?? "").trim();
    return n || (userEmail ? String(userEmail) : null);
  };

  // Money in a sentence a person reads. Matches customer-accept's fmtMoney character for
  // character, so the consent text on a rep attestation and on a customer signature read
  // alike in the evidence table -- they are the same event recorded by different people.
  const usd = (n: number): string => {
    const v = Math.round(n * 100) / 100;
    const [int, frac] = Math.abs(v).toFixed(2).split(".");
    return `${v < 0 ? "-" : ""}$${int.replace(/\B(?=(\d{3})+(?!\d))/g, ",")}.${frac}`;
  };

  // The customer's "here is what changed, please approve it" email. ONE definition, called by
  // finalize_amendment (which sends it as part of finishing) and by send_change_order (the
  // resend button). Two copies would drift the moment either grew a line.
  // deno-lint-ignore no-explicit-any
  const emailChangeOrder = async (co: any): Promise<{ sent: boolean; reason: string | null }> => {
    const { data: d } = await admin.from("designs")
      .select("contact, ss_quote_number")
      .eq("client_id", clientId).eq("short_code", co.short_code).maybeSingle();
    const to = String((d?.contact as { email?: unknown } | null)?.email ?? "").trim();
    if (!isEmail(to)) return { sent: false, reason: "no email address on this design" };
    const { data: cs } = await admin.from("client_settings")
      .select("business_name, business_phone, business_website, business_logo_url, quote_terms")
      .eq("client_id", clientId).maybeSingle();
    const content = changeOrderEmail({
      businessName: String(cs?.business_name ?? "").trim() || clientId,
      logoUrl: cs?.business_logo_url,
      phone: cs?.business_phone,
      website: cs?.business_website,
      quoteNumber: String(d?.ss_quote_number || co.short_code),
      coNo: Number(co.co_no) || 0,
      description: String(co.description || ""),
      totalBefore: co.total_before_cents == null ? null : co.total_before_cents / 100,
      totalAfter: co.total_after_cents == null ? null : co.total_after_cents / 100,
      reviewUrl: myQuotesUrl(clientId, req),
      quoteTerms: cs?.quote_terms,
    });
    const outcome = await sendTenantEmail(admin, clientId, {
      kind: "change_order", shortCode: co.short_code, to,
      subject: content.subject, html: content.html, text: content.text,
    });
    // ⚠️ "failed" IS NOT A REASON, it is a status repeated back (found while testing the
    // whole flow on beta, 2026-09-08). The rep's screen said "not emailed (failed)", which
    // tells them nothing they can act on — while the server had the provider's actual answer
    // sitting in `outcome.error`: `resend 422/validation_error`, i.e. the address was
    // rejected. sendTenantEmail's contract carries both; only `reason` was being read.
    //
    // Every branch here names something the builder can DO. The raw provider string is
    // deliberately not passed through — it is logged in email_sends.error for us, and
    // "resend 422/validation_error" on a builder's screen is noise wearing authority.
    if (outcome.sent) return { sent: true, reason: null };
    const detail = String((outcome as { error?: unknown }).error ?? "");
    const reason = outcome.reason === "not_active"
      ? "your sending domain isn't live yet — check Settings → Branding → Email"
      : /4(0[0-9]|2[0-9])|validation|invalid|recipient/i.test(detail)
        ? `that email address was rejected (${to})`
        : "the send didn't go through";
    return { sent: false, reason };
  };

  // amendment_status: everything the Change Order button needs before it acts.
  if (action === "amendment_status") {
    const shortCode = String(payload?.shortCode ?? "").trim();
    if (!shortCode) return json({ error: "A design code is required." }, 400);

    const gate = await amendmentGate(shortCode);
    const [liveRes, unlockRes, csRes] = await Promise.all([
      admin.from("change_orders")
        .select("id, co_no, status, source, description, total_before_cents, total_after_cents, fee_cents, fee_tax_cents, fee_taxable, raised_under, created_at")
        .eq("client_id", clientId).eq("short_code", shortCode)
        .in("status", ["draft", "pending_ack"]).limit(1),
      admin.from("order_unlocks")
        .select("id, reason, requested_by_name, requested_at, decision, decided_by_name, decided_at, decision_note, expires_at")
        .eq("client_id", clientId).eq("short_code", shortCode)
        .is("consumed_at", null).is("released_at", null)
        .order("created_at", { ascending: false }).limit(1),
      admin.from("client_settings")
        .select("co_unlock_required, co_free_days, co_fee_cents, co_fee_taxable, co_fee_label")
        .eq("client_id", clientId).maybeSingle(),
    ]);
    // Soft on every leg: this read decides which BUTTON renders, and a blank screen is a
    // worse answer than a conservative one.
    return json({
      ok: true,
      gate,
      amendment: liveRes.error ? null : (liveRes.data?.[0] ?? null),
      unlock: unlockRes.error ? null : (unlockRes.data?.[0] ?? null),
      policy: csRes.error || !csRes.data ? null : {
        unlockRequired: csRes.data.co_unlock_required === true,
        freeDays: Number(csRes.data.co_free_days ?? 0),
        feeCents: Number(csRes.data.co_fee_cents ?? 0),
        feeTaxable: csRes.data.co_fee_taxable === true,
        feeLabel: String(csRes.data.co_fee_label ?? "Change order fee"),
      },
    });
  }

  // request_order_unlock: the rep asks.
  if (action === "request_order_unlock") {
    const shortCode = String(payload?.shortCode ?? "").trim();
    const reason = String(payload?.reason ?? "").trim().slice(0, 500);
    if (!shortCode) return json({ error: "A design code is required." }, 400);
    // The reason is not paperwork: it is what the approver reads before deciding, and it
    // lands permanently on the order's amendment trail.
    if (!reason) return json({ error: "Say what needs changing -- whoever unlocks it will read this." }, 400);

    const gate = await amendmentGate(shortCode);
    if (gate.open === true) {
      return json({ ok: true, needed: false, reason: String(gate.reason ?? ""), gate });
    }

    // CLOSER #1 from 210: an unlock that expired unused is released here rather than
    // blocking the next request, and the release says why. The partial unique index cannot
    // carry `expires_at > now()` (now() is not immutable), which is what makes this the
    // place that has to do it.
    await admin.from("order_unlocks")
      .update({ released_at: new Date().toISOString(), release_reason: "expired unused" })
      .eq("client_id", clientId).eq("short_code", shortCode)
      .eq("decision", "granted").is("consumed_at", null).is("released_at", null)
      .lt("expires_at", new Date().toISOString());

    // ⚠️ NO `.neq("decision", "declined")` HERE, and that is not an oversight. A WAITING
    // request has decision NULL, and `decision <> 'declined'` is NULL for a NULL — three-
    // valued logic drops the row rather than keeping it. That filter made this check blind to
    // exactly the row it exists to find: the second request fell through to the insert and
    // came back as a 500 from the one-open-unlock index. Filter in JS, where null is null.
    const { data: openRows } = await admin.from("order_unlocks")
      .select("id, decision, requested_by_name, requested_at, expires_at")
      .eq("client_id", clientId).eq("short_code", shortCode)
      .is("consumed_at", null).is("released_at", null)
      .limit(5);
    const openRow = (openRows ?? []).filter((u) => u.decision !== "declined");
    if (openRow?.[0]) {
      return json({
        ok: true, already: true, unlock: openRow[0],
        message: openRow[0].decision === "granted"
          ? "This order is already unlocked."
          : "Someone has already asked to unlock this order.",
      });
    }

    const name = await callerName();
    const { data: row, error: insErr } = await admin.from("order_unlocks").insert({
      client_id: clientId, short_code: shortCode,
      requested_by: userId ?? null, requested_by_name: name,
      requested_at: new Date().toISOString(), reason,
    }).select("id, reason, requested_by_name, requested_at").maybeSingle();
    // Belt and braces behind the check above: the index is the real claim, and losing a race
    // to it means somebody else asked first — which is an answer, not a fault.
    if (insErr) {
      if (String(insErr.code) === "23505") {
        return json({ ok: true, already: true, message: "Someone has already asked to unlock this order." });
      }
      return dbFail(req, clientId, "ask for that order to be unlocked", insErr);
    }
    await audit("unlock_requested", null, `design=${shortCode}`).catch(() => {});
    return json({ ok: true, requested: true, unlock: row });
  }

  // decide_order_unlock: the approver answers.
  // The ONLY action gated on change_order_approve. An approver may also unlock an order
  // nobody has asked about -- the builder often decides the change is happening before the
  // rep has typed anything -- so a missing request is created and granted in one step
  // rather than refused.
  if (action === "decide_order_unlock") {
    const shortCode = String(payload?.shortCode ?? "").trim();
    const decision = payload?.decision === "declined" ? "declined" : "granted";
    const note = String(payload?.note ?? "").trim().slice(0, 500) || null;
    if (!shortCode) return json({ error: "A design code is required." }, 400);

    const { data: cs } = await admin.from("client_settings")
      .select("co_unlock_hours").eq("client_id", clientId).maybeSingle();
    const hours = Math.min(720, Math.max(1, Number(cs?.co_unlock_hours ?? 72)));
    const nowIso = new Date().toISOString();
    const expiresIso = new Date(Date.now() + hours * 3600_000).toISOString();
    const name = await callerName();

    const patch = {
      decision, decided_by: userId ?? null, decided_by_name: name,
      decided_at: nowIso, decision_note: note,
      // A DECLINE HAS NO EXPIRY -- nothing is being granted. The grant_shape CHECK only
      // demands expires_at of a 'granted' row.
      expires_at: decision === "granted" ? expiresIso : null,
    };

    const { data: pending } = await admin.from("order_unlocks")
      .select("id").eq("client_id", clientId).eq("short_code", shortCode)
      .is("decision", null).is("consumed_at", null).is("released_at", null)
      .order("created_at", { ascending: false }).limit(1);

    let row;
    if (pending?.[0]) {
      const upd = await admin.from("order_unlocks").update(patch)
        .eq("id", pending[0].id).select("id, decision, decided_by_name, decided_at, expires_at, decision_note").maybeSingle();
      if (upd.error) return dbFail(req, clientId, "record that decision", upd.error);
      row = upd.data;
    } else {
      if (decision === "declined") {
        return json({ error: "There is nothing to decline -- nobody has asked to unlock this order." }, 400);
      }
      const ins = await admin.from("order_unlocks").insert({
        client_id: clientId, short_code: shortCode,
        reason: note ?? "Unlocked without a request", ...patch,
      }).select("id, decision, decided_by_name, decided_at, expires_at, decision_note").maybeSingle();
      // The one-open-unlock index is the concurrency claim; a duplicate means somebody
      // else got there first, which is not an error the approver needs to see as one.
      if (ins.error) {
        if (String(ins.error.code) === "23505") {
          return json({ ok: true, already: true, message: "This order is already unlocked." });
        }
        return dbFail(req, clientId, "unlock that order", ins.error);
      }
      row = ins.data;
    }

    await auditStrict(`unlock_${decision}`, null, `design=${shortCode} hours=${decision === "granted" ? hours : 0}`);
    return json({ ok: true, unlock: row });
  }

  // open_amendment: spend the unlock, open the draft.
  // The draft is the rep's workspace: invisible to the customer (customer-quotes shows
  // pending_ack only) and deliberately not a block on invoicing. Everything that decides
  // whether this is allowed -- and what it costs -- is stamped by the guard trigger from the
  // gate, never read from this handler's caller.
  if (action === "open_amendment") {
    const shortCode = String(payload?.shortCode ?? "").trim();
    if (!shortCode) return json({ error: "A design code is required." }, 400);

    const { data: d } = await admin.from("designs")
      .select("short_code, ss_quote_number, accepted_at, estimate_lines, selections, paint_colors")
      .eq("client_id", clientId).eq("short_code", shortCode).maybeSingle();
    if (!d) return json({ error: "Design not found." }, 404);
    if (!d.ss_quote_number) return json({ error: "This design has no StructureStudio quote yet." }, 400);

    const { data: existing } = await admin.from("change_orders")
      .select("id, co_no, status, fee_cents, fee_tax_cents, raised_under")
      .eq("client_id", clientId).eq("short_code", shortCode)
      .in("status", ["draft", "pending_ack"]).limit(1);
    if (existing?.[0]) {
      return json({ ok: true, already: true, changeOrder: existing[0] });
    }

    const gate = await amendmentGate(shortCode);
    if (gate.open !== true) {
      return json({ error: String(gate.reason ?? "This order is signed and has to be unlocked first."), reason: "locked" }, 409);
    }

    // THE UNDO POINT, stamped HERE rather than at the first save (2026-09-07). The rep is
    // about to edit the real design in the real designer -- there is no shadow copy, which is
    // what makes "change anything, including the drawing" true without a second designer. So
    // the only record of what the order looked like before is the one taken now. Without it
    // "Discard the change" voids the change order and leaves the EDIT on the design, which is
    // the discard drift the order screen has been warning about since migration 127.
    //
    // Same column and same shape stage_order_attribute_change writes, and that handler already
    // declines to overwrite an existing snapshot_before -- so a rep who opens the amendment and
    // then uses the order-screen dropdowns still restores to the right place.
    const undoPoint = {
      estimateLines: d.estimate_lines, selections: d.selections, paintColors: d.paint_colors,
    };
    // What the customer last put their name to, for the CO's version_before. Same read
    // stage_order_attribute_change makes; null is acceptable (older designs have no version).
    const { data: acc } = await admin.from("design_acceptances").select("design_version")
      .eq("client_id", clientId).eq("short_code", shortCode)
      .order("accepted_at", { ascending: false }).limit(1).maybeSingle();

    // source 'design_edit': the rep is about to open the designer, and the description is
    // GENERATED from the line diff when the amendment is finished -- never typed. A manual
    // amendment converts on finalize; it cannot be decided here, before any editing.
    const { data: co, error: coErr } = await admin.from("change_orders").insert({
      client_id: clientId, short_code: shortCode, source: "design_edit", status: "draft",
      description: "Change in progress",
      snapshot_before: undoPoint,
      version_before: acc?.design_version ?? null,
    }).select("id, co_no, status, raised_under, unlock_id, fee_cents, fee_tax_cents, fee_taxable").maybeSingle();
    if (coErr) {
      // The trigger's refusal is a sentence written for a person; pass it through rather
      // than burying it under dbFail's generic label.
      //
      // ⚠️ MATCHED NARROWLY, against the gate's OWN sentence. A loose /unlock|signed/ test
      // read a foreign-key error naming `order_unlocks` as a refusal and told the rep their
      // order was locked, when the real answer was a bug in the trigger (see migration 214).
      // Anything this does not recognise is a fault and must go through dbFail, where it is
      // logged with its Postgres detail instead of being shown to a builder as policy.
      const msg = String(coErr.message ?? "");
      if (/has to unlock it|unlock it before it can be changed|This order is signed/i.test(msg)) {
        return json({ error: msg, reason: "locked" }, 409);
      }
      if (String(coErr.code) === "23505") return json({ error: "Someone just opened a change on this order." }, 409);
      return dbFail(req, clientId, "open that change", coErr);
    }
    await audit("amendment_opened", null, `design=${shortCode} co=${co?.co_no} under=${co?.raised_under}`).catch(() => {});
    return json({ ok: true, changeOrder: co });
  }

  // ── finalize_amendment: the rep is done editing; price it and ask the customer ─────────
  //
  // The draft becomes a real change order here, and every number on it is DERIVED. Nothing
  // in the payload decides money or words: the description comes from the line diff
  // (changeOrderDescription over the agreed baseline), the totals come from the snapshots
  // either side of it, and the fee was stamped by the guard trigger when the change was
  // opened and is frozen against every later write. A rep summarising their own change is
  // how an acknowledgment drifts from the reality it is supposed to record.
  if (action === "finalize_amendment") {
    const coId = String(payload?.changeOrderId ?? "").trim();
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(coId)) {
      return json({ error: "changeOrderId is required." }, 400);
    }
    const { data: co, error: coErr } = await admin.from("change_orders")
      .select("id, short_code, co_no, status, source, fee_cents, fee_tax_cents, fee_taxable, version_before")
      .eq("client_id", clientId).eq("id", coId).maybeSingle();
    if (coErr) return dbFail(req, clientId, "load that change", coErr);
    if (!co) return json({ error: "Change order not found." }, 404);
    if (co.status === "pending_ack") {
      return json({ ok: true, already: true, changeOrder: co });
    }
    if (co.status !== "draft") {
      return json({
        error: co.status === "acknowledged"
          ? "This change order is already acknowledged."
          : "This change order was discarded — open a new one.",
      }, 400);
    }

    const { data: d, error: dErr } = await admin.from("designs")
      .select("short_code, ss_quote_number, image_url, estimate_lines, accepted_snapshot, selections, paint_colors")
      .eq("client_id", clientId).eq("short_code", co.short_code).maybeSingle();
    if (dErr) return dbFail(req, clientId, "load that design", dErr);
    if (!d) return json({ error: "Design not found." }, 404);

    const agreed = agreedBaseline(d);
    const description = changeOrderDescription(agreed.lines, d.estimate_lines);
    const totalBefore = totalFromSnapshot(agreed.lines);
    const totalAfter = totalFromSnapshot(d.estimate_lines);

    // NOTHING CHANGED. Refuse rather than send the customer a change order describing no
    // change — and say which of the two things to do about it, because a rep who opened this
    // by mistake otherwise leaves a draft sitting on the order blocking the next one (the
    // one-live-amendment index) with no idea why.
    if (!description && totalBefore === totalAfter) {
      return json({
        error: "Nothing has changed on this order yet. Open the designer and make the change, or discard this one.",
        reason: "no_change",
      }, 400);
    }

    let versionAfter: number | null = null;
    {
      const { data: maxV } = await admin.from("design_versions").select("version")
        .eq("short_code", co.short_code).order("version", { ascending: false }).limit(1).maybeSingle();
      versionAfter = maxV?.version == null ? null : Number(maxV.version);
    }

    // `.eq("status","draft")` is the concurrency claim, not a formality: two reps on the same
    // order would otherwise both "finish" it, and the second would rewrite words and money on
    // a change the customer had already been emailed.
    const { data: sent, error: updErr } = await admin.from("change_orders")
      .update({
        status: "pending_ack",
        description: description ?? `Change to quote ${d.ss_quote_number ?? co.short_code}`,
        total_before_cents: totalBefore == null ? null : Math.round(totalBefore * 100),
        total_after_cents: totalAfter == null ? null : Math.round(totalAfter * 100),
        version_after: versionAfter,
      })
      .eq("client_id", clientId).eq("id", co.id).eq("status", "draft")
      .select("id, co_no, status, description, total_before_cents, total_after_cents, fee_cents, fee_tax_cents, fee_taxable, short_code")
      .maybeSingle();
    if (updErr) return dbFail(req, clientId, "finish that change", updErr);
    if (!sent) return json({ error: "Somebody else just finished this change." }, 409);

    // The customer's quote PDF becomes the PROPOSAL — the document showing what they are
    // being asked to approve, which is what it should show while an amendment is open. It is
    // NOT the signed invoice: that lives at its own path and is never regenerated here, so
    // nothing the customer has already put their name to is overwritten. The acceptance
    // certificate on the quote is re-appended by regenerateQuotePdf itself.
    const quotePdfUrl = await regenerateQuotePdf(admin, req, clientId, co.short_code, {
      quoteNumber: String(d.ss_quote_number ?? co.short_code), snap: d.estimate_lines, planUrl: d.image_url,
    });

    const mail = await emailChangeOrder(sent);
    await audit("amendment_finalized", null,
      `design=${co.short_code} co=${sent.co_no} before=${totalBefore ?? "-"} after=${totalAfter ?? "-"} fee=${sent.fee_cents ?? 0}`).catch(() => {});
    return json({
      ok: true, changeOrder: sent, description: sent.description,
      totalBefore, totalAfter, quotePdfUrl, sent: mail.sent, sendReason: mail.reason,
    });
  }

  // ── attest_change_order: the rep records that the customer said yes ────────────────────
  //
  // MOVED OFF THE BROWSER (2026-09-07). The portal used to write `change_orders` directly
  // under RLS for a verbal acknowledgment. That could never write the other half of the
  // record: `design_acceptances` has SELECT policies and nothing else (migration 124), so
  // writes are service-role only BY CONSTRUCTION — which is the entire safety argument behind
  // rep-attested acceptance, and it cannot be honoured from a browser. Carolyn asked for a
  // fresh signature on the amended order "or fill in the details we already have in place for
  // it"; this is that second half, and it has to leave the same kind of evidence as the first.
  //
  // The row is subject='invoice' with revision = co_no (migration 213): the customer is
  // approving the WHOLE revised order, not a document beside it. Revision 0 keeps the original
  // signature verbatim; nothing is updated and nothing is deleted.
  if (action === "attest_change_order") {
    const coId = String(payload?.changeOrderId ?? "").trim();
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(coId)) {
      return json({ error: "changeOrderId is required." }, 400);
    }
    // When they said yes. Defaults to today; a rep recording yesterday's phone call should be
    // able to say so, and the CHECK behind ack_method='verbal' demands the date either way.
    const rawDate = String(payload?.conversationDate ?? "").trim();
    const conversationDate = /^\d{4}-\d{2}-\d{2}$/.test(rawDate)
      ? rawDate
      : new Date().toISOString().slice(0, 10);
    if (conversationDate > new Date().toISOString().slice(0, 10)) {
      return json({ error: "That conversation date is in the future." }, 400);
    }

    const { data: co, error: coErr } = await admin.from("change_orders")
      .select("id, short_code, co_no, status, description, total_before_cents, total_after_cents, fee_cents, fee_tax_cents, fee_taxable")
      .eq("client_id", clientId).eq("id", coId).maybeSingle();
    if (coErr) return dbFail(req, clientId, "load that change", coErr);
    if (!co) return json({ error: "Change order not found." }, 404);
    if (co.status === "acknowledged") return json({ ok: true, already: true });
    if (co.status !== "pending_ack") {
      return json({
        error: co.status === "draft"
          ? "This change isn't finished yet — finish it before recording their approval."
          : "This change order was discarded.",
      }, 400);
    }

    const { data: d, error: dErr } = await admin.from("designs")
      .select("short_code, ss_quote_number, image_url, contact, estimate_lines, accepted_snapshot")
      .eq("client_id", clientId).eq("short_code", co.short_code).maybeSingle();
    if (dErr) return dbFail(req, clientId, "load that design", dErr);
    if (!d) return json({ error: "Design not found." }, 404);

    // WHO IS ATTESTING. From the verified session, never from the body — the
    // change_orders.verbal_recorded_by posture, and design_acceptances_rep_named_check
    // refuses the insert without it anyway. Denormalised because this row is evidence: it has
    // to still read correctly after the person is renamed or gone.
    const recordedByName = (await callerName()) ?? "";
    if (!recordedByName.trim()) {
      return json({ error: "We couldn't tell who is recording this. Sign out and back in, then try again." }, 400);
    }

    // ── THE NUMBER THEY AGREED TO ────────────────────────────────────────────────────────
    // The whole amended order, fee included — not the change in isolation. This is the figure
    // that goes into a sentence standing as the customer's approval, so it is computed from
    // the same helper the acknowledging write will use a moment later rather than from a
    // second arithmetic that could disagree with the money actually recorded.
    const { data: ackedNow } = await admin.from("change_orders")
      .select("co_no, description, total_before_cents, total_after_cents, fee_cents, fee_tax_cents, fee_taxable")
      .eq("client_id", clientId).eq("short_code", co.short_code).eq("status", "acknowledged");
    const projected = orderCentsAfterAck(d.estimate_lines, [...(ackedNow ?? []), co]);
    const newTotal = projected == null ? null : projected.totalCents / 100;

    // ── REFUND OWED ──────────────────────────────────────────────────────────────────────
    // Carolyn: show a cheaper-than-paid order as a refund owed. The customer should learn
    // that at the moment their approval is recorded, not from a balance card weeks later.
    let settledCents = 0;
    {
      const { data: ord } = await admin.from("orders").select("id")
        .eq("client_id", clientId).eq("short_code", co.short_code).maybeSingle();
      if (ord?.id) {
        const { data: pays } = await admin.from("payments")
          .select("amount_cents, funding_state, voided_at")
          .eq("client_id", clientId).eq("order_id", ord.id);
        for (const pmt of Array.isArray(pays) ? pays : []) {
          if (pmt.voided_at) continue;
          if (pmt.funding_state === "pending" || pmt.funding_state === "returned") continue;
          settledCents += Number(pmt.amount_cents) || 0;
        }
      }
    }
    const refundCents = projected == null ? 0 : Math.max(0, settledCents - projected.totalCents);

    const quoteNo = String(d.ss_quote_number || co.short_code);
    const coLabel = `CO-${co.co_no}`;
    const feeCents = Number(co.fee_cents) || 0;
    const feeTaxCents = Number(co.fee_tax_cents) || 0;

    // The consent text is the durable evidence, composed HERE and stored verbatim. It is
    // written in the REP's voice throughout and ends with the clause that makes it honest —
    // that sentence is the difference between a record and a forged signature.
    const consentText =
      `${recordedByName} recorded ${String((d.contact as { name?: unknown } | null)?.name ?? "").trim() || "the customer"}'s approval of change order ` +
      `${coLabel} to quote ${quoteNo}, given on ${conversationDate}` +
      (newTotal == null ? "" : `, for a revised order total of ${usd(newTotal)}`) +
      (feeCents > 0 ? `, which includes a change order fee of ${usd((feeCents + feeTaxCents) / 100)}` : "") +
      (refundCents > 0 ? `. The revised total is below what has already been paid, leaving ${usd(refundCents / 100)} to be refunded` : "") +
      `. This is the builder's record of the customer's approval, not the customer's signature.`;

    const acceptanceId = crypto.randomUUID();
    const ackAtIso = new Date().toISOString();
    const { error: insErr } = await admin.from("design_acceptances").insert({
      id: acceptanceId,
      client_id: clientId,
      short_code: co.short_code,
      // The WHOLE revised order, which is what they approved — and revision IS co_no, so the
      // document a customer signed and the change it describes can never be numbered apart.
      subject: "invoice",
      revision: Number(co.co_no) || 0,
      change_order_id: co.id,
      quote_number: quoteNo,
      total: newTotal,
      // The tax as the AMENDED document carries it — that is what was approved.
      ...taxFreeze(d.estimate_lines),
      method: "rep",
      signer_name: String((d.contact as { name?: unknown } | null)?.name ?? "").trim() || "(no name on file)",
      consent_text: consentText,
      // Not a claim about identity here (nothing matches on it — the customer never opened a
      // session), just what the order has on file. Empty is honest and the column is NOT NULL.
      phone_digits: phoneKey((d.contact as { phone?: unknown } | null)?.phone),
      recorded_by_user_id: userId ?? null,
      recorded_by_name: recordedByName,
      ip: clientIp(req),
      user_agent: (req.headers.get("user-agent") || "").slice(0, 300) || null,
      accepted_at: ackAtIso,
    });
    if (insErr) {
      // design_acceptances_co_once: somebody already recorded an answer for this change.
      if (String(insErr.code) === "23505") return json({ ok: true, already: true });
      return dbFail(req, clientId, "record that approval", insErr);
    }

    const { data: flipped, error: ackErr } = await admin.from("change_orders")
      .update({
        status: "acknowledged", ack_method: "verbal", acceptance_id: acceptanceId,
        acknowledged_at: ackAtIso, verbal_rep_name: recordedByName,
        verbal_conversation_date: conversationDate, verbal_recorded_by: userId ?? null,
      })
      .eq("client_id", clientId).eq("id", co.id).eq("status", "pending_ack")
      .select("id, co_no").maybeSingle();
    if (ackErr || !flipped) {
      logEdgeError({
        fn: "portal-settings", req, clientId, code: 500,
        message: `CO attest flip failed: ${ackErr?.message ?? "no row"}`, context: { coId },
      }).catch(() => {});
      return json({ error: "The approval was recorded but the change didn't finalize. It's on the order — try again, or call it in." }, 500);
    }

    // ── THE ORDER'S MONEY ────────────────────────────────────────────────────────────────
    // Re-read AFTER the flip, deliberately: change_orders_stamp_agreed (153) has by now moved
    // accepted_snapshot forward onto the revision that was just agreed, and the acknowledged
    // list now includes this change. Computing from stale copies is how the fee gets refunded
    // by the next change order.
    {
      const [{ data: freshD }, { data: allAcked }] = await Promise.all([
        admin.from("designs").select("estimate_lines, accepted_snapshot")
          .eq("client_id", clientId).eq("short_code", co.short_code).maybeSingle(),
        admin.from("change_orders")
          .select("co_no, description, total_before_cents, total_after_cents, fee_cents, fee_tax_cents, fee_taxable")
          .eq("client_id", clientId).eq("short_code", co.short_code).eq("status", "acknowledged"),
      ]);
      const money = orderCentsAfterAck(agreedBaseline(freshD).lines, allAcked ?? []);
      if (money != null) {
        // total_source='manual' also shields it from sync-design-status' GHL repricer.
        const { error: totErr } = await admin.from("orders")
          .update({
            total_cents: money.totalCents,
            pretax_subtotal_cents: money.pretaxCents,
            tax_cents: money.taxCents,
            total_source: "manual",
            updated_at: ackAtIso,
          })
          .eq("client_id", clientId).eq("short_code", co.short_code);
        if (totErr) {
          logEdgeError({
            fn: "portal-settings", req, clientId, code: 500,
            message: `CO attest order-total update failed: ${totErr.message}`, context: { coId },
          }).catch(() => {});
        }
      }
    }

    // The quote PDF stops being a proposal and becomes the agreed document.
    const quotePdfUrl = await regenerateQuotePdf(admin, req, clientId, co.short_code, {
      quoteNumber: quoteNo, snap: d.estimate_lines, planUrl: d.image_url,
    });

    await auditStrict("change_order_attested", null,
      `design=${co.short_code} co=${co.co_no} by=${recordedByName} on=${conversationDate}`);
    return json({
      ok: true, acknowledgedAt: ackAtIso, coNo: co.co_no,
      total: newTotal, refundCents, quotePdfUrl, consentText,
    });
  }

  // ── reissue_invoice: rebuild the invoice document after an approved change ────────────
  //
  // ⚠️ THIS IS THE REMEDY THE STALE-INVOICE REFUSAL NAMES, and until 2026-09-08 it did not
  // exist. Three places refuse a payment when an approved change is newer than the invoice
  // ("Regenerate and resend it, then take the payment") -- the customer's pay screen, the
  // invoice signature, and the rep's terminal. But:
  //
  //   * an invoice whose email already SENT returned "This design was already invoiced";
  //   * the retry branch re-sent the STORED pdf, never rebuilding it, and moved the
  //     staleness timestamp only if the email landed.
  //
  // So on an order whose customer email bounces -- an @example.com address, a typo, a
  // customer with no email at all -- the refusal could never clear and NOBODY could take
  // payment on that order again. Survivable while amending a signed order was rare; the
  // change-order rebuild makes it ordinary, and Carolyn's requirement is explicitly that a
  // change can happen after delivery and final payment.
  //
  // The email is BEST-EFFORT here and deliberately not the point: the document is what the
  // refusal is about, so `document_at` moves when the PDF is rebuilt whether or not anything
  // is delivered (221). A builder with the customer in front of them can print it.
  if (action === "reissue_invoice") {
    const shortCode = String(payload?.shortCode ?? "").trim();
    if (!shortCode) return json({ error: "A design code is required." }, 400);

    const { data: d, error: dErr } = await admin.from("designs")
      .select("short_code, status, ss_quote_number, image_url, estimate_lines, accepted_snapshot, contact")
      .eq("client_id", clientId).eq("short_code", shortCode).maybeSingle();
    if (dErr) return dbFail(req, clientId, "load that design", dErr);
    if (!d) return json({ error: "Design not found." }, 404);

    const { data: inv, error: iErr } = await admin.from("invoice_sends")
      .select("invoice_number, invoice_pdf_url, issued_by, status")
      .eq("client_id", clientId).eq("short_code", shortCode).maybeSingle();
    if (iErr) return dbFail(req, clientId, "load that invoice", iErr);
    if (!inv || !inv.invoice_number || String(inv.issued_by) !== "structurestudio") {
      return json({ error: "There is no StructureStudio invoice on this order to reissue." }, 400);
    }

    // A change nobody has approved is not on the bill yet, so rebuilding now would print a
    // document that is wrong in the other direction. Same refusal send_invoice makes.
    {
      const { data: pend } = await admin.from("change_orders").select("co_no")
        .eq("client_id", clientId).eq("short_code", shortCode).in("status", ["draft", "pending_ack"]).limit(1);
      if (pend?.[0]) {
        return json({ error: `Change CO-${pend[0].co_no} hasn't been approved yet. Settle that first — reissuing now would print a figure that is about to move.` }, 409);
      }
    }

    // The SAME arithmetic send_invoice uses. agreedBaseline + acknowledged changes + the
    // order's PRE-TAX figure, so the lines foot and the tax row lands on top exactly as they
    // do on the original document. The fee label is joined in for the fee lines.
    const agreedLines = agreedBaseline(d).lines;
    const [coRes, ordRes, csRes] = await Promise.all([
      admin.from("change_orders")
        .select("co_no, description, total_before_cents, total_after_cents, fee_cents, fee_tax_cents, fee_taxable")
        .eq("client_id", clientId).eq("short_code", shortCode).eq("status", "acknowledged"),
      admin.from("orders").select("total_cents, pretax_subtotal_cents")
        .eq("client_id", clientId).eq("short_code", shortCode).maybeSingle(),
      admin.from("client_settings")
        .select("business_name, business_phone, business_website, business_address, quote_terms, co_fee_label")
        .eq("client_id", clientId).maybeSingle(),
    ]);
    const feeLabel = String(csRes.data?.co_fee_label ?? "").trim() || "Change order fee";
    const acked = (coRes.error ? [] : (coRes.data ?? [])).map((c) => ({ ...c, fee_label: feeLabel }));
    const pretax = ordRes.data?.pretax_subtotal_cents ?? ordRes.data?.total_cents ?? null;
    const amended = amendedInvoiceDocument(agreedLines, acked, pretax == null ? null : Number(pretax));

    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const expectedPdfPrefix = `${supabaseUrl}/storage/v1/object/public/floor-plans/${clientId}/`;
    const planUrl = d.image_url && String(d.image_url).startsWith(expectedPdfPrefix) ? String(d.image_url) : null;

    let pdfUrl = inv.invoice_pdf_url as string | null;
    try {
      let pdfBytes = await buildQuotePdf({
        docKind: "invoice",
        business: {
          name: String(csRes.data?.business_name ?? "").trim() || clientId,
          phone: csRes.data?.business_phone ?? null,
          website: csRes.data?.business_website ?? null,
          address: csRes.data?.business_address ?? null,
        },
        estimateNumber: String(inv.invoice_number),
        dateIso: new Date().toISOString(),
        // deno-lint-ignore no-explicit-any
        lines: amended.lines.map((l: any) => ({ ...l, desc: deHtml(String(l?.desc ?? "")) })),
        discount: amended.discount,
        tax: amended.tax,
        // deno-lint-ignore no-explicit-any
        discountRows: (agreedLines as any)?.discounts?.rows ?? null,
        quoteTerms: csRes.data?.quote_terms ?? null,
        planPdfUrl: planUrl,
      });

      // ── RE-APPEND THE ACCEPTANCE CERTIFICATE ───────────────────────────────────────
      // This upload overwrites the SAME storage path customer-accept countersigned, so
      // without this the first reissue after a signature silently replaces the signed
      // invoice with an unsigned one — and a change order is the ordinary trigger, since
      // the CO ack path never rebuilds the document itself and this action is the remedy
      // it points at. The quote twin (regenerateQuotePdf) has always done this; the
      // invoice is the document customers actually sign, so it matters more here.
      // Migration 213 writes one design_acceptances row per revision with subject='invoice'
      // and revision=co_no, so the newest revision is the one the rebuilt figures reflect —
      // but the certificate must be the newest acceptance that CARRIES A CUSTOMER SIGNATURE,
      // which is not the same row. `attest_change_order` writes one of those per-revision
      // rows with method='rep': the BUILDER's record of a verbal approval, whose own consent
      // sentence ends "not the customer's signature". Taking the newest revision outright
      // lets a rep-attested change order out-rank a drawn signature, and the reissue then
      // appends nothing and overwrites the countersigned PDF with an unsigned one — the exact
      // loss this block exists to prevent, one change order later. So the METHOD IS FILTERED
      // IN THE QUERY, and the newest row that survives that filter is the one stamped.
      const { data: acc } = await admin.from("design_acceptances")
        .select("method, signer_name, typed_signature, signature_image_path, accepted_at, ip, consent_text, total")
        .eq("client_id", clientId).eq("short_code", shortCode).eq("subject", "invoice")
        .in("method", ["drawn", "typed"])
        .order("revision", { ascending: false }).limit(1).maybeSingle();
      // Only a real signature earns a certificate page — the same rule the quote path
      // states: a page asserting a typed signature over an empty name claims more than
      // the customer did. The query already filters on it; this restates the rule where the
      // certificate is actually built, so changing one of the two cannot quietly stamp a
      // page for a method nobody signed with.
      if (acc && (acc.method === "drawn" || acc.method === "typed")) {
        let signaturePng: Uint8Array | null = null;
        if (acc.signature_image_path) {
          // storage.download() RESOLVES with { data: null, error } for a missing or denied
          // object — it does NOT throw — so the failure is only visible on dl.error. That is
          // the convention the repo already follows (portal-feedback/index.ts). The catch is
          // kept for a genuine throw (network/abort); on its own it was dead code.
          // A failed embed must NOT be silent: with no PNG the certificate falls through to
          // acceptancePdf's italic branch and prints the customer's NAME under "Signed by
          // hand on the customer quote page", which claims more than the record holds. The
          // rebuild still ships — the facts-and-consent page beats an unsigned document —
          // but it leaves a row saying which failure this was.
          let failure = "";
          try {
            const dl = await admin.storage.from("signatures").download(String(acc.signature_image_path));
            if (dl.data) signaturePng = new Uint8Array(await dl.data.arrayBuffer());
            else failure = dl.error?.message || "download returned no data and no error";
          } catch (e) {
            failure = String(e);
          }
          if (failure) {
            logEdgeError({
              fn: "portal-settings", req, clientId, code: "invoice_signature_png_unreadable",
              message: `reissue_invoice: signature image download failed: ${failure}`,
              context: { shortCode, path: String(acc.signature_image_path) },
            }).catch(() => {});
          }
        }
        pdfBytes = await appendAcceptancePage(pdfBytes, {
          businessName: csRes.data?.business_name ?? null,
          quoteNumber: String(inv.invoice_number),
          total: acc.total == null ? null : Number(acc.total),
          signerName: String(acc.signer_name ?? ""),
          method: acc.method === "drawn" ? "drawn" : "typed",
          signaturePng,
          typedSignature: acc.typed_signature ?? null,
          acceptedAtIso: String(acc.accepted_at ?? ""),
          ip: acc.ip == null ? null : String(acc.ip),
          consentText: String(acc.consent_text ?? ""),
          docLabel: "Invoice",
        });
      }

      const pdfPath = `${clientId}/${shortCode}-invoice.pdf`;
      const up = await admin.storage.from("floor-plans")
        .upload(pdfPath, pdfBytes, FIXED_PATH_PDF_UPLOAD);
      if (up.error) return dbFail(req, clientId, "rebuild the invoice document", up.error);
      const { data: pub } = admin.storage.from("floor-plans").getPublicUrl(pdfPath);
      pdfUrl = pub?.publicUrl || pdfUrl;
    } catch (e) {
      logEdgeError({
        fn: "portal-settings", req, clientId, code: 500,
        message: `reissue_invoice PDF build failed: ${(e as Error).message}`, context: { shortCode },
      }).catch(() => {});
      return json({ error: "The invoice document couldn't be rebuilt. Try again — if it keeps happening, tell CSM Synergy and mention \"reissue the invoice\"." }, 500);
    }

    // THE WRITE THAT CLEARS THE REFUSAL. `document_at` — not `updated_at`, which the customer
    // is shown as "sent" and which must not claim a send that did not happen.
    const nowIso2 = new Date().toISOString();
    const { error: recErr } = await admin.from("invoice_sends")
      .update({ invoice_pdf_url: pdfUrl, document_at: nowIso2 })
      .eq("client_id", clientId).eq("short_code", shortCode);
    if (recErr) return dbFail(req, clientId, "record the reissued invoice", recErr);

    // The email is a courtesy on this path, never the point — see the header.
    let sent = false;
    let sendReason: string | null = null;
    const to = String((d.contact as { email?: unknown } | null)?.email ?? "").trim();
    if (payload?.sendEmail !== false && isEmail(to)) {
      const owed = amountOwed(agreedLines, acked, ordRes.data?.total_cents == null ? null : Number(ordRes.data.total_cents));
      const content = invoiceEmail({
        businessName: String(csRes.data?.business_name ?? "").trim() || clientId,
        logoUrl: null, phone: csRes.data?.business_phone, website: csRes.data?.business_website,
        invoiceNumber: String(inv.invoice_number),
        total: owed ?? "",
        invoiceUrl: pdfUrl,
        quoteTerms: csRes.data?.quote_terms,
        signUrl: myQuotesUrl(clientId, req),
      });
      const out = await sendTenantEmail(admin, clientId, {
        kind: "invoice", shortCode, to, subject: content.subject, html: content.html, text: content.text,
      });
      sent = out.sent;
      if (out.sent) {
        await admin.from("invoice_sends").update({ status: "sent", error: null, updated_at: new Date().toISOString() })
          .eq("client_id", clientId).eq("short_code", shortCode);
      } else {
        const det = String((out as { error?: unknown }).error ?? "");
        sendReason = out.reason === "not_active"
          ? "your sending domain isn't live yet"
          : /\b4(0[0-9]|2[0-9])\b|validation|invalid|recipient/i.test(det)
            ? `that email address was rejected (${to})`
            : "the send didn't go through";
      }
    } else if (!isEmail(to)) {
      sendReason = "this design has no email address";
    }

    await audit("invoice_reissued", null, `design=${shortCode} invoice=${inv.invoice_number} emailed=${sent}`).catch(() => {});
    return json({ ok: true, invoiceNumber: inv.invoice_number, invoicePdfUrl: pdfUrl, sent, sendReason });
  }

  if (action === "send_change_order") {
    const coId = String(payload?.changeOrderId ?? "").trim();
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(coId)) {
      return json({ error: "changeOrderId is required." }, 400);
    }
    const { data: co, error: coErr } = await admin.from("change_orders")
      .select("id, short_code, co_no, status, description, total_before_cents, total_after_cents")
      .eq("client_id", clientId).eq("id", coId).maybeSingle();
    if (coErr) return dbFail(req, clientId, "load that change order", coErr);
    if (!co) return json({ error: "Change order not found." }, 404);
    if (co.status !== "pending_ack") {
      return json({
        error: co.status === "draft"
          // A draft has no priced diff yet and the customer has never been told it exists.
          ? "This change is still open -- finish it before sending it to the customer."
          : co.status === "acknowledged" ? "This change order is already acknowledged." : "This change order was voided.",
      }, 400);
    }
    // One body, shared with finalize_amendment (which sends the first copy). This action is
    // the RESEND: same email, same numbers, so a customer who lost the first one cannot be
    // handed a second that says something different.
    const outcome = await emailChangeOrder(co);
    return json({ ok: true, sent: outcome.sent, reason: outcome.reason });
  }

  // ── order_paperwork: everything the invoice-style order document needs (migration 127) ──
  // One call: the tenant's letterhead identity, the active colors palette (labels + flags +
  // hex for the dropdowns — deliberately NO rates; prices are only ever computed server-side
  // by the staging action), and the invoice_sends fields the sidebar shows (the table is
  // ── orders_designs: the designs behind the orders on screen ──────────────────────────
  // 154_area_access_rls.sql:84-95 wrote this action's spec before it was needed, on the day
  // the designs RLS policy was deliberately NOT widened: "the day OrdersView ships to tenants
  // this becomes real for all four titles holding orders >= 'view'. Fix it THEN, in code —
  // move the designs read behind a portal-settings action gated { area: 'orders', level:
  // 'view' }, so the SERVER decides which design rows an order viewer may see."
  //
  // That day is today. A crew leader or driver holds orders:'view' and designs:'none'; before
  // this, OrdersView read designs straight through RLS and would have handed them every
  // customer's name, phone, selections and figures. The tempting shortcut — widening the
  // designs policy to `designs OR orders` — is explicitly refused there and stays refused:
  // designs_ensure_order mints an order row for EVERY accepted design, so that EXISTS
  // resolves to "every design ever sold" and gives the least privileged title in the product
  // a clean list of exactly the thing the policy exists to withhold.
  //
  // The projection is deliberately narrow and fixed here rather than chosen by the caller: a
  // browser must not be able to widen its own column list.
  if (action === "orders_designs") {
    const codes = Array.isArray(payload?.shortCodes)
      ? payload.shortCodes.map((c: unknown) => String(c ?? "").trim()).filter(Boolean).slice(0, 2000)
      : [];
    const detail = payload?.detail === true;
    if (!codes.length) return json({ ok: true, designs: [] });
    if (detail && codes.length !== 1) {
      return json({ error: "detail reads one design at a time." }, 400);
    }
    // The order document needs the priced snapshot and the configuration it was priced from;
    // the list needs only enough to label a row. Two shapes, one gate, neither caller-chosen.
    //
    // ── ROW SCOPE (migration 193) ──────────────────────────────────────────────────────
    // contact_id joins the projection for one reason: it is what the row filter keys on, and
    // resolving it here costs nothing where a second query would cost a round trip carrying
    // up to 2000 short codes. Both shapes return `contact` — the customer's name, phone and
    // email — so a rep on contacts:'own' holding orders:'view' would otherwise read every
    // customer in the business off the Orders tab, which is the exact leak this action was
    // created to close for crew leaders and drivers one gate up.
    const cols = detail
      ? "short_code, contact_id, status, accepted_at, ss_quote_number, ss_quote_pdf_url, ss_quote_sent_at, image_url, plan_image_url, view3d_image_url, estimate_lines, selections, paint_colors, contact"
      // ss_invoice_requested_at (migration 229) is what turns an accepted order's chip into
      // "Invoice to approve". ⚠️ Selecting it before the column exists 500s this whole read,
      // which empties the Orders tab — migration 229 must be applied BEFORE this deploys.
      : "short_code, contact_id, contact, selections, status, image_url, ghl_estimate_number, ss_quote_number, ss_quote_pdf_url, ss_invoice_sent_at, ss_invoice_requested_at";
    const { data, error } = await admin.from("designs")
      .select(cols).eq("client_id", clientId).in("short_code", codes).limit(2000);
    if (error) return dbFail(req, clientId, "read the designs for these orders", error);
    const visible = await visibleDesignRows((data || []) as { contact_id?: string | null }[]);
    if (!visible) return dbFail(req, clientId, "check who these customers are assigned to", { message: "contact scope unavailable" });
    return json({ ok: true, designs: visible });
  }

  // service-role only, so this is its portal projection).
  if (action === "order_paperwork") {
    const shortCode = String(payload?.shortCode ?? "").trim();
    if (!shortCode) return json({ error: "shortCode is required." }, 400);
    const { data: cs, error: csErr } = await admin.from("client_settings")
      .select("invoice_in_ghl, business_name, business_phone, business_website, business_logo_url, quote_terms")
      .eq("client_id", clientId).maybeSingle();
    if (csErr) return dbFail(req, clientId, "read your settings", csErr);
    if (!cs || cs.invoice_in_ghl !== false) {
      return json({ error: "This account quotes through the CRM — the order document is for StructureStudio-issued paperwork." }, 400);
    }
    const [colRes, invRes] = await Promise.all([
      admin.from("colors")
        .select("id, label, hex, siding, trim, shingle, metal, allow_custom, is_default, sort_order")
        .eq("client_id", clientId).eq("active", true).order("sort_order", { ascending: true }),
      admin.from("invoice_sends")
        .select("status, issued_by, invoice_number, invoice_pdf_url, created_at, updated_at, document_at, signed_at, acceptance_id")
        .eq("client_id", clientId).eq("short_code", shortCode).maybeSingle(),
    ]);
    if (colRes.error) return dbFail(req, clientId, "read your colors", colRes.error);
    // The cladding THIS DESIGN'S STYLE offers (207), so the document's dropdown lists what the
    // tenant actually sells and calls it what they call it. Before this the browser carried a
    // compiled-in list of three that had drifted from the designer's four — it omitted
    // `batten`, and because the staging action validated against the same list and defaults to
    // the design's CURRENT value, a Board & Batten design could not have ANY attribute changed
    // on its order, not even a roof colour.
    //
    // Fails SOFT to an empty list: the browser falls back to the built-in four, which is what
    // an account with no rows yet should see. A colours read failing blanks the document
    // because you cannot price paint without a palette; a cladding read failing must not.
    let cladding: { id: string; label: string | null }[] = [];
    {
      const dRes = await admin.from("designs").select("selections")
        .eq("client_id", clientId).eq("short_code", shortCode).maybeSingle();
      const styleKey = String(((dRes.data?.selections ?? {}) as Record<string, unknown>).style ?? "").trim();
      if (!dRes.error && styleKey) {
        const stRow = await admin.from("building_styles").select("id")
          .eq("client_id", clientId).eq("key", styleKey).maybeSingle();
        if (!stRow.error && stRow.data?.id) {
          const scRows = await admin.from("style_cladding").select("cladding_id, label_override, sort_order")
            .eq("client_id", clientId).eq("style_id", stRow.data.id).eq("active", true)
            .not("rate", "is", null).order("sort_order");
          if (!scRows.error) {
            cladding = (scRows.data ?? []).map((r: { cladding_id: string; label_override: string | null }) =>
              ({ id: r.cladding_id, label: r.label_override }));
          }
        }
      }
    }
    return json({
      ok: true,
      business: {
        name: cs.business_name || null,
        phone: cs.business_phone || null,
        website: cs.business_website || null,
        logoUrl: cs.business_logo_url || null,
        quoteTerms: cs.quote_terms || null,
      },
      colors: colRes.data || [],
      cladding,
      invoice: invRes.error ? null : (invRes.data || null),
    });
  }

  // ── stage_order_attribute_change: the order document's live dropdowns (migration 127) ──
  //
  // A rep changed roof type/color, cladding, or paint on the order screen. The delta is
  // priced with the SAME catalog math the quote used (_shared/attributeLines.ts — the
  // extraction of submit-estimate's colorAmount + line builders), and ONLY the paint/roof
  // lines of the stored estimate_lines snapshot are touched — never a full re-price, so a
  // signed order can't absorb unrelated catalog drift, and never a GHL side effect.
  //
  // Applies at STAGING (the same semantics as the designer-resubmit CO): the design row
  // updates now, the customer acknowledges after.
  //
  // TWO DIFFERENT COLUMNS, deliberately (migration 153 — do not re-conflate them):
  //   * the MONEY/DIFF BASELINE is designs.accepted_snapshot, via agreedBaseline() — the
  //     design as of the customer's last AGREEMENT, the same helper and the same input
  //     submit-estimate uses, so both design_edit writers stamp the identical
  //     total_before_cents instead of overwriting each other with different numbers.
  //   * change_orders.snapshot_before (127) is THIS SCREEN'S UNDO POINT — the pre-stage
  //     design, revisions included, which is what void_change_order restores. It is NOT
  //     "the design as the customer signed it": on a CO adopted from a designer resubmit it
  //     holds that unacknowledged revision. Written exactly where it was before and read by
  //     nothing else, so discard behaviour is unchanged.
  if (action === "stage_order_attribute_change") {
    const shortCode = String(payload?.shortCode ?? "").trim();
    if (!shortCode) return json({ error: "shortCode is required." }, 400);
    const attrs = (payload?.attrs && typeof payload.attrs === "object") ? payload.attrs : {};
    const dryRun = payload?.dryRun === true;
    const has = (k: string) => Object.prototype.hasOwnProperty.call(attrs, k);
    if (!["roofType", "roofColor", "cladding", "paintStatus", "paintBody", "paintTrim"].some(has)) {
      return json({ error: "Nothing to change." }, 400);
    }

    const { data: d, error: dErr } = await admin.from("designs")
      .select("short_code, status, accepted_at, ss_quote_number, ss_quote_pdf_url, image_url, estimate_lines, accepted_snapshot, selections, paint_colors, contact, custom_options, ro_dimensions, items, bldg_w, bldg_h, inventory_unit_id")
      .eq("client_id", clientId).eq("short_code", shortCode).maybeSingle();
    if (dErr) return dbFail(req, clientId, "find that design", dErr);
    if (!d) return json({ error: "Design not found." }, 404);
    if (!d.ss_quote_number) return json({ error: "This design has no StructureStudio quote yet." }, 400);
    const dStatus = String(d.status || "");
    // WAS: a flat refusal on invoiced/delivered -- "its paperwork is frozen. Raise a manual
    // change order instead." That single line is what made Carolyn's requirement false:
    // "a change order can happen anytime throughout the process up until after delivery and
    // final payment." The question is no longer WHICH STATUS the order is in but whether the
    // builder's own rules leave it open -- the free window, or an unlock somebody granted.
    // Same gate the trigger asks, so a refusal here and a refusal there always agree.
    {
      const gate = await amendmentGate(shortCode);
      if (gate.open !== true) {
        return json({
          error: String(gate.reason ?? "This order is signed. Ask an admin or crew leader to unlock it."),
          reason: "locked",
        }, 409);
      }
    }
    // ── ANOTHER KIND OF CHANGE ORDER IS ALREADY LIVE ON THIS ORDER (2026-09-17) ──
    // change_orders_one_live (211) allows one live CO per design and is SOURCE-BLIND, but the
    // adoption lookup further down reads only 'design_edit' rows. A manual CO waiting on the
    // customer was therefore invisible here: the handler priced the change, REWROTE THE DESIGN
    // ROW, then hit the index on the insert, answering a 500 and leaving the order revised with
    // no change order recorded. Neither order screen locks these dropdowns for a manual CO.
    // Refused before any write and before the dry-run preview, so the rep hears it the moment
    // they touch a dropdown and nothing has moved. A live design_edit CO is not refused: this
    // handler adopts it below, which is the intended path.
    {
      const { data: liveCo, error: liveErr } = await admin.from("change_orders")
        .select("co_no, status, source")
        .eq("client_id", clientId).eq("short_code", shortCode)
        .in("status", ["draft", "pending_ack"])
        .limit(1).maybeSingle();
      if (liveErr) return dbFail(req, clientId, "check this order's change orders", liveErr);
      if (liveCo && String(liveCo.source) !== "design_edit") {
        return json({
          error: String(liveCo.status) === "draft"
            ? `CO-${liveCo.co_no} is still open — finish it or void it under Change orders before changing the building.`
            : `CO-${liveCo.co_no} is still waiting on the customer — record their verbal OK or void it under Change orders before changing the building.`,
          reason: "co_pending",
        }, 409);
      }
    }
    // deno-lint-ignore no-explicit-any
    const snap: any = d.estimate_lines;
    if (!snap || !Array.isArray(snap.lines)) {
      return json({ error: "This design has no priced snapshot — resubmit it from the designer first." }, 400);
    }

    const sel = (d.selections || {}) as Record<string, unknown>;
    const pc = (d.paint_colors || {}) as Record<string, unknown>;

    // Current values (stored shapes: selections.paint 'Painted'/'No Paint', paint_colors
    // {body,trim}, selections.roofType/roofColor, selections.cladding = the id).
    const cur = {
      roofType: String(sel.roofType ?? "").trim(),
      roofColor: String(sel.roofColor ?? "").trim(),
      cladding: String(sel.cladding ?? ""),
      paintStatus: (sel.paint && String(sel.paint).toLowerCase() === "painted") ? "Paint" : "Unpaint" as "Paint" | "Unpaint",
      paintBody: String(pc.body ?? "").trim(),
      paintTrim: String(pc.trim ?? "").trim(),
    };
    const next = {
      roofType: has("roofType") ? String(attrs.roofType ?? "").trim() : cur.roofType,
      roofColor: has("roofColor") ? String(attrs.roofColor ?? "").trim() : cur.roofColor,
      cladding: has("cladding") ? String(attrs.cladding ?? "") : cur.cladding,
      paintStatus: has("paintStatus")
        ? (String(attrs.paintStatus) === "Paint" ? "Paint" : "Unpaint") as "Paint" | "Unpaint"
        : cur.paintStatus,
      paintBody: has("paintBody") ? String(attrs.paintBody ?? "").trim() : cur.paintBody,
      paintTrim: has("paintTrim") ? String(attrs.paintTrim ?? "").trim() : cur.paintTrim,
    };

    // ── Validate against the catalog, loudly. ──
    // Cladding is per tenant, per STYLE since 207, so the offered set comes from this design's
    // own style rather than from a list compiled into the function. A tenant or a style with no
    // rows falls back to the closed four, which is how an account that predates 207 keeps
    // behaving exactly as it did. (The old code validated against CLADDING_OPTIONS alone, and
    // that list was missing `batten` — see attributeLines.ts for what that cost.)
    const cladOverrides: Record<string, string> = {};
    let cladOffered: string[] = [];
    {
      const styleKey = String(sel.style ?? "").trim();
      if (styleKey) {
        const stRow = await admin.from("building_styles").select("id")
          .eq("client_id", clientId).eq("key", styleKey).maybeSingle();
        if (stRow.error) return dbFail(req, clientId, "read that design's style", stRow.error);
        if (stRow.data?.id) {
          const scRows = await admin.from("style_cladding").select("cladding_id, label_override")
            .eq("client_id", clientId).eq("style_id", stRow.data.id).eq("active", true).not("rate", "is", null);
          if (scRows.error) return dbFail(req, clientId, "read your cladding", scRows.error);
          for (const r of (scRows.data ?? []) as { cladding_id: string; label_override: string | null }[]) {
            cladOffered.push(r.cladding_id);
            if (r.label_override) cladOverrides[r.cladding_id] = r.label_override;
          }
        }
      }
    }
    const cladOk = (id: string) => cladOffered.length
      ? cladOffered.includes(id)
      : CLADDING_OPTIONS.some((c) => c.id === id);
    if (next.cladding && !cladOk(next.cladding)) {
      return json({ error: "That cladding isn't offered on this building style. Check Settings → Options → Cladding." }, 400);
    }
    const { data: colRows, error: colErr } = await admin.from("colors")
      .select("id, label, rate, pricing_method, allow_custom, siding, trim, shingle, metal")
      .eq("client_id", clientId).eq("active", true);
    if (colErr) return dbFail(req, clientId, "read your colors", colErr);
    const palette = colRows || [];
    const labelOk = (v: string, flag: "siding" | "trim" | "shingle" | "metal") =>
      !v || attrNorm(v) === attrNorm("TBD") || attrNorm(v) === attrNorm("No Paint") ||
      palette.some((c) => (c as Record<string, unknown>)[flag] === true && attrNorm(c.label) === attrNorm(v)) ||
      palette.some((c) => c.allow_custom); // free text prices at the allow-custom rate, like the designer
    if (next.roofType && !["shingle", "metal"].includes(attrNorm(next.roofType))) {
      return json({ error: "Roof type must be Shingle or Metal." }, 400);
    }
    if (next.roofType) {
      const flag = attrNorm(next.roofType) === "metal" ? "metal" : "shingle";
      if (!palette.some((c) => (c as Record<string, unknown>)[flag] === true)) {
        return json({ error: `No ${next.roofType} roof colors are set up in your catalog.` }, 400);
      }
      if (!labelOk(next.roofColor, flag as "shingle" | "metal")) return json({ error: "That roof color isn't in your catalog." }, 400);
    }
    if (next.paintStatus === "Paint") {
      if (!labelOk(next.paintBody, "siding")) return json({ error: "That body color isn't in your catalog." }, 400);
      if (!labelOk(next.paintTrim, "trim")) return json({ error: "That trim color isn't in your catalog." }, 400);
    }

    // ── Re-price ONLY the paint/roof lines, with the quote's exact math. ──
    const ctx = await resolveBuildingContext(admin, clientId, sel.style, sel.size);
    if (!ctx) {
      // Never price an attribute change against a $0 building: a renamed style/size must
      // fail loudly (submit-estimate:425 precedent), not zero a signed order's delta.
      return json({ error: `Couldn't match "${sel.style} ${sel.size}" in your catalog — was the style or size renamed? Fix the catalog (or resubmit from the designer), then try again.` }, 400);
    }
    const paint = computePaintLine(palette, ctx, next.paintStatus, next.paintBody || "TBD", next.paintTrim || "TBD");
    const roof = computeRoofLine(palette, ctx, next.roofType, next.roofColor);

    // deno-lint-ignore no-explicit-any
    const newSnap: any = JSON.parse(JSON.stringify(snap));
    let sawRoof = false;
    for (const li of newSnap.lines) {
      if (li && li.kind === "paint") { li.amount = paint.amount; li.desc = paint.desc; }
      if (li && li.kind === "roof") { li.amount = roof.amount; li.desc = roof.desc; sawRoof = true; }
    }
    // The tenant offers roofs but the signed snapshot predates a roof pick: append the
    // line the way submit-estimate would have (only when a type is actually chosen now).
    if (!sawRoof && next.roofType) {
      newSnap.lines.push({ kind: "roof", itemKey: "", name: "Roof", desc: roof.desc, qty: 1, amount: roof.amount, nonTaxable: false });
    }

    // ── Re-price the tax on the NEW lines (migration 158) ──────────────────────────────
    //
    // newSnap is a deep CLONE of the signed snapshot, so without this it carries that
    // snapshot's `tax` object verbatim while its lines have just changed — and totalAfter is
    // the number the customer is asked to approve. A change order that adds a taxable roof
    // upcharge would be presented at the OLD tax, understating what they will owe.
    //
    // NO LOOKUP HERE (2026-09-16/17). This used to re-ask Avalara on every change, so a rep
    // recolouring a roof on a signed order made a billed call nobody chose to make. It now
    // re-stamps through the same chain submit-estimate uses (_shared/taxChain.ts):
    //   0. a SIGNED order CARRIES the tax the customer agreed to (agreedTax): rate, label,
    //      source, jurisdiction, basis, location and times verbatim, the amount and pools
    //      recomputed for the new lines. Whatever rate it was, verified or a location's or the
    //      company's, and whatever happened since: a lot deleted or re-rated, a delivery address
    //      edited. A change order must never carry a tax-rate line nobody chose (review,
    //      2026-09-17); the rate on a signed order changes only by a deliberate feature;
    //   1. otherwise (nobody has signed it) a verified rate is CARRIED while the delivery state
    //      and ZIP still match the ones it was verified for — the caller here is always staff, so
    //      an address that moved falls through with "address changed — re-verify";
    //   2. the order's sales location rate;
    //   3. the company rate;
    //   4. refuse — never the silent 0% this path used to price a signed order's tax at.
    // No home lot: the person staging a change on a signed order did not necessarily sell it.
    // Only when the snapshot already carried tax — a pre-tax design stays pre-tax, and no
    // CRM-mode design ever enters this branch. Reads and pure work only up to the dry-run
    // return below, so a preview writes nothing and spends nothing.
    let resolvedCo: ResolvedRate | null = null;
    if (newSnap.tax) {
      const addrCo = addressFrom(d.contact);
      const poolsCo = subtotalsFromSnapshot(newSnap)!; // non-null: snap.lines was checked above
      const signedTaxCo = agreedTax(d);
      const carryCo: CarryDecision = signedTaxCo
        ? { carry: true }
        : carryDecision({ staffCaller: true, storedTax: snap.tax, address: addrCo });
      if (carryCo.carry) {
        newSnap.tax = carriedTax(signedTaxCo ?? snap.tax, poolsCo);
      } else {
        const [csRes, locRes] = await Promise.all([
          admin.from("client_settings").select("ss_tax_rate, ss_tax_label").eq("client_id", clientId).maybeSingle(),
          admin.from("designs").select("sales_location_id").eq("client_id", clientId).eq("short_code", shortCode).maybeSingle(),
        ]);
        // Unread is not unset: an unreadable rate must refuse as a fault, not price at 0%.
        if (csRes.error) return dbFail(req, clientId, "read your sales tax rate", csRes.error);
        if (locRes.error) return dbFail(req, clientId, "read this order's sales location", locRes.error);
        const salesLocationId = locRes.data?.sales_location_id ? String(locRes.data.sales_location_id) : null;
        let locationCo: TaxLocation | null = null;
        if (salesLocationId) {
          const lotRes = await admin.from("builder_locations").select(TAX_LOCATION_COLUMNS)
            .eq("client_id", clientId).eq("id", salesLocationId).maybeSingle();
          if (lotRes.error) return dbFail(req, clientId, "read this order's sales location", lotRes.error);
          locationCo = taxLocationFrom(lotRes.data, clientId);
        }
        const choiceCo = chooseDefaultRate({
          salesLocationId, location: locationCo, homeLot: null,
          companyRate: csRes.data?.ss_tax_rate, companyLabel: csRes.data?.ss_tax_label ?? null,
        });
        if (!choiceCo) {
          return json({
            error: "This account has no sales tax rate set, so this change can't be priced. Add one in Settings → CRM Connection → Quotes & Invoices (enter 0% if you don't collect sales tax).",
            reason: "no_tax_rate",
          }, 400);
        }
        // allowLookup stays FALSE: only the chosen default comes back, as source "fallback".
        resolvedCo = await resolveRate(addrCo, choiceCo.rate, { allowLookup: false });
        newSnap.tax = stampTax({ pools: poolsCo, resolved: resolvedCo, choice: choiceCo, address: addrCo, reason: carryCo.reason });
      }
    }

    // The live CO, if any. snapshot_before is still read — but ONLY for the adoption stamp
    // further down, never as a baseline (see the header: it is the undo point).
    //
    // 'draft' JOINED 'pending_ack' HERE ON 2026-09-07, and it is not cosmetic. open_amendment
    // creates a DRAFT and that is now the ordinary way a change on a signed order begins — so
    // a rep who opens the amendment and then reaches for these dropdowns finds a row this
    // lookup could not see, falls through to the INSERT below, and collides with the
    // one-live-amendment index. The same widening submit-estimate's own lookup already got.
    const { data: existingCo } = await admin.from("change_orders")
      .select("id, co_no, status, version_before, snapshot_before")
      .eq("client_id", clientId).eq("short_code", shortCode)
      .in("status", ["draft", "pending_ack"]).eq("source", "design_edit")
      .limit(1).maybeSingle();
    // The baseline is what the customer AGREED to (153). It used to be
    // `snapshot_before ?? the live design`, and on a CO adopted from a designer resubmit
    // that fell through to the already-revised design AND then stamped that revision into
    // snapshot_before — permanently recording an unacknowledged revision as the signed
    // state, which is how a customer came to sign against a total they never approved.
    const base = agreedBaseline(d);
    const baseLines = base.lines;
    const baseSel = base.selections as Record<string, unknown>;
    const basePc = base.paintColors as Record<string, unknown>;

    const totalBefore = totalFromSnapshot(baseLines);
    const totalAfter = totalFromSnapshot(newSnap);

    // The description the customer signs: explicit attribute sentences (cladding is
    // invisible to the line diff, and "options updated" is too vague to sign) + the money.
    // Built by re-diffing against a snapshot, wholesale, on every write — never appended to
    // the previous one, which would repeat every sentence whose attribute moved twice.
    const nextPaintStatus = next.paintStatus === "Paint" ? "Painted" : "Unpainted";
    const describeFrom = (fromSel: Record<string, unknown>, fromPc: Record<string, unknown>): string[] => {
      const out: string[] = [];
      const say = (label: string, from: string, to: string) => {
        if (attrNorm(from) !== attrNorm(to)) out.push(`${label}: ${from || "—"} → ${to || "—"}`);
      };
      const fromPaintStatus = (fromSel.paint && String(fromSel.paint).toLowerCase() === "painted") ? "Painted" : "Unpainted";
      say("Roof type", String(fromSel.roofType ?? ""), next.roofType);
      say("Roof color", String(fromSel.roofColor ?? ""), next.roofColor);
      // The tenant's own name for it, so the sentence the customer signs matches the word
      // that was on their quote.
      say("Cladding", claddingLabel(fromSel.cladding, cladOverrides), claddingLabel(next.cladding, cladOverrides));
      say("Paint", fromPaintStatus, nextPaintStatus);
      if (next.paintStatus === "Paint") {
        say("Paint body", String(fromPc.body ?? ""), next.paintBody);
        say("Paint trim", String(fromPc.trim ?? ""), next.paintTrim);
      }
      return out;
    };
    // THE NO-OP TEST IS AGAINST THE CURRENT DESIGN, not the baseline. A designer revision can
    // have moved an attribute since the customer agreed; putting it BACK is a real change to
    // the design (and to the money) even though, measured against the agreement, it looks
    // like nothing happened. Testing the baseline here would refuse that request outright.
    const vsCurrent = describeFrom(sel, pc);
    if (vsCurrent.length === 0) {
      return json({ error: "That matches what the design already carries." }, 400);
    }
    // Normally the cumulative sentences, against what the customer agreed to. When the
    // request lands exactly back on the agreed values those come out empty, so fall back to
    // the current-design sentences — REPLACING the list, never concatenating the two.
    let sentences = describeFrom(baseSel, basePc);
    if (sentences.length === 0) sentences = vsCurrent;
    const fmtM = (n: number) => {
      const v = Math.round(n * 100) / 100;
      const [int, frac] = Math.abs(v).toFixed(2).split(".");
      return `${v < 0 ? "-" : ""}$${int.replace(/\B(?=(\d{3})+(?!\d))/g, ",")}.${frac}`;
    };
    // THE WORDS MUST COVER EVERYTHING THE TOTAL LINE SPANS. describeFrom() knows only roof,
    // cladding and paint — it has no line-level diff. Since 153 the Total runs from the AGREED
    // design, so when the live row ALSO carries a designer revision the money moves by lines
    // no sentence mentions: a $700 increase described purely as a roof colour change, the
    // added $500 window invisible. Worse, this description then OVERWRITES the designer CO's
    // own line-diff text on the pending row, so the only place that named the window is gone.
    // So the line diff over the very same two snapshots the Total is computed from rides
    // along — and it brings its own Total sentence (identical numbers, identical formatting
    // to fmtM), which is why nothing is pushed after it.
    const lineDiff = changeOrderDescription(baseLines, newSnap);
    if (lineDiff) {
      sentences = sentences.concat(lineDiff.split("\n"));
    } else if (totalBefore != null && totalAfter != null) {
      // Nothing moved in the lines or the money — a change of spec at no cost. State the
      // total anyway: the customer is signing a document that has to say what they will owe.
      sentences.push(`Total: ${fmtM(totalBefore)} → ${fmtM(totalAfter)}`);
    }
    const description = sentences.join("\n");

    if (dryRun) {
      return json({ ok: true, preview: true, totalBefore, totalAfter, description });
    }

    // ── Persist: the design row, a version row, the CO, the regenerated PDF. ──
    const nowIso = new Date().toISOString();
    const newSelections = {
      ...sel,
      roofType: next.roofType,
      roofColor: next.roofColor,
      cladding: next.cladding,
      claddingId: next.cladding,
      paint: next.paintStatus === "Paint" ? "Painted" : "No Paint",
    };
    const newPaintColors = next.paintStatus === "Paint" ? { body: next.paintBody, trim: next.paintTrim } : { body: "", trim: "" };
    const { error: updErr } = await admin.from("designs")
      // total_cents rides the snapshot it is derived from, in the SAME update (206), so the
      // card can never show a figure from a quote revision that is no longer on the design.
      .update({ selections: newSelections, paint_colors: newPaintColors, estimate_lines: newSnap, total_cents: designTotalCents(newSnap), updated_at: nowIso })
      .eq("client_id", clientId).eq("short_code", shortCode);
    if (updErr) return dbFail(req, clientId, "apply the change", updErr);

    // METERED (179) — WIRED, AND UNREACHABLE ON THIS PATH (2026-09-17). Only a real Avalara
    // answer may be charged, and the resolve above passes allowLookup false, so
    // `resolvedCo.source` is never "avalara"; a CARRIED verified rate leaves resolvedCo null
    // because no call was made. Moved below the dry-run return and the design write on the
    // same day: a preview must never be able to charge, and a charge must never land for a
    // document that was not written. NO AUTOMATIC PATH MAY SPEND — do not flip allowLookup.
    if (resolvedCo?.source === "avalara") {
      const meterCo = await chargeTaxCalculation(admin, {
        clientId,
        kind: "tax_lookup",
        idem: taxLookupIdem(clientId, String(shortCode), resolvedCo.rate, resolvedCo.jurisdiction),
        refType: "change_order",
        refId: String(shortCode),
        memo: `Sales tax lookup${resolvedCo.jurisdiction ? ` — ${resolvedCo.jurisdiction}` : ""}`,
        actorUserId: userId ?? null,
      });
      if (!meterCo.charged && meterCo.reason === "error") {
        logEdgeError({
          fn: "portal-settings", req, clientId, code: "tax_meter",
          message: `tax_lookup charge failed for change order on ${shortCode}`,
        }).catch(() => {});
      }
    }

    // A real design_versions row, so the CO's version_after points at something (031 shape).
    let versionAfter: number | null = null;
    try {
      const { data: maxV } = await admin.from("design_versions").select("version")
        .eq("short_code", shortCode).order("version", { ascending: false }).limit(1).maybeSingle();
      versionAfter = (Number(maxV?.version) || 0) + 1;
      await admin.from("design_versions").insert({
        short_code: shortCode, client_id: clientId, version: versionAfter,
        contact: d.contact, selections: newSelections, paint_colors: newPaintColors,
        items: d.items, custom_options: d.custom_options, ro_dimensions: d.ro_dimensions,
        bldg_w: d.bldg_w, bldg_h: d.bldg_h, image_url: d.image_url,
        inventory_unit_id: d.inventory_unit_id ?? null,
      });
    } catch (_e) { versionAfter = null; /* version history is bookkeeping, not the change */ }

    // The change order — only once the customer has signed something to change.
    let changeOrderId: string | null = null;
    let coNo: number | null = null;
    if (d.accepted_at) {
      const coFields = {
        description,
        total_before_cents: totalBefore == null ? null : Math.round(totalBefore * 100),
        total_after_cents: totalAfter == null ? null : Math.round(totalAfter * 100),
        version_after: versionAfter,
      };
      if (existingCo) {
        const { error: coErr } = await admin.from("change_orders")
          .update({
            ...coFields,
            // First staging over a designer-raised CO adopts it: stamp the UNDO POINT (the
            // design as it stood before this staging — the designer's revision included, so
            // it is not "as signed") so a discard can restore, keeping version_before.
            // Deliberately still the only writer of snapshot_before: void_change_order reads
            // nothing else, so its behaviour is byte-identical to before 153.
            ...(existingCo.snapshot_before ? {} : { snapshot_before: { estimateLines: snap, selections: sel, paintColors: pc } }),
          })
          // A DRAFT STAYS A DRAFT. Staging prices the change; it does not decide that the
          // customer should be asked to approve it — finalize_amendment does that, once the
          // rep says they are finished. Sending a half-made change for signature because
          // someone touched a dropdown is precisely the wrong direction to fail in.
          .eq("id", existingCo.id).in("status", ["draft", "pending_ack"]);
        if (coErr) return dbFail(req, clientId, "update the change order", coErr);
        changeOrderId = existingCo.id; coNo = existingCo.co_no;
      } else {
        const { data: acc } = await admin.from("design_acceptances").select("design_version")
          .eq("client_id", clientId).eq("short_code", shortCode)
          .order("accepted_at", { ascending: false }).limit(1).maybeSingle();
        const { data: coRow, error: coErr } = await admin.from("change_orders")
          .insert({
            client_id: clientId, short_code: shortCode, source: "design_edit",
            ...coFields,
            version_before: acc?.design_version ?? null,
            snapshot_before: { estimateLines: snap, selections: sel, paintColors: pc },
          })
          .select("id, co_no").maybeSingle();
        if (coErr && String(coErr.code) === "23505") {
          // RACE BACKSTOP for the co_pending refusal above: another change order went live on
          // this order between that check and this insert (a second tab, a double submit).
          // Same refusal shape as the check. The design row HAS been written by now, so an
          // explicit info row keeps that visible — this function does not log 4xx on its own.
          await logEdgeError({
            fn: "portal-settings", req, clientId, severity: "info", code: "co_pending_race",
            message: "stage_order_attribute_change: another change order went live before the insert",
            context: { shortCode, designWritten: true },
          });
          return json({
            error: "Another change order was opened on this order at the same moment — reload the order and check Change orders before changing the building again.",
            reason: "co_pending",
          }, 409);
        }
        if (coErr) return dbFail(req, clientId, "raise the change order", coErr);
        changeOrderId = coRow?.id ?? null; coNo = coRow?.co_no ?? null;
      }
    }

    // Regenerate the quote PDF from the patched snapshot, keeping the customer's
    // acceptance certificate page (regeneration must never silently drop the countersign).
    //
    // KEPT, DELIBERATELY (2026-09-07). The plan carried an open item to stop regenerating
    // here, on the theory that the customer's document was moving under them mid-approval.
    // Two things settle it the other way. The signed INVOICE pdf lives at its own path and is
    // never touched by this — nothing the customer has put their name to is overwritten. And
    // with the money pinned to the agreed baseline, what a regenerate now produces is exactly
    // the document showing the customer the change they are being ASKED to approve, which is
    // what a proposal should show. finalize_amendment and attest_change_order regenerate from
    // the same helper at their own moments, so the file is never left stale on any path.
    const quotePdfUrl = await regenerateQuotePdf(admin, req, clientId, shortCode, {
      quoteNumber: String(d.ss_quote_number), snap: newSnap, planUrl: d.image_url,
    });

    // `pendingAck` drives the order screen's "waiting on the customer" copy, so a DRAFT must
    // report false — nobody has been asked anything yet.
    const stagedIsDraft = String(existingCo?.status ?? "") === "draft";
    return json({ ok: true, changeOrderId, coNo, totalBefore, totalAfter, description, quotePdfUrl, pendingAck: !!changeOrderId && !stagedIsDraft, draft: stagedIsDraft });
  }

  // ── void_change_order: discard a staged-but-unsigned change (migration 127) ──
  // Pending only. When the CO carries snapshot_before (staged from the order document, or
  // adopted by it), the design is RESTORED as the customer signed it and the PDF is
  // regenerated; a designer-resubmit CO without a snapshot voids only (today's behavior).
  if (action === "void_change_order") {
    const coId = String(payload?.changeOrderId ?? "").trim();
    const reason = String(payload?.reason ?? "").trim();
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(coId)) {
      return json({ error: "changeOrderId is required." }, 400);
    }
    if (!reason) return json({ error: "Voiding a change order needs a reason." }, 400);
    const { data: co, error: coErr } = await admin.from("change_orders")
      .select("id, short_code, co_no, status, snapshot_before")
      .eq("client_id", clientId).eq("id", coId).maybeSingle();
    if (coErr) return dbFail(req, clientId, "load that change order", coErr);
    if (!co) return json({ error: "Change order not found." }, 404);
    // A DRAFT IS DISCARDABLE -- that is what the rep's "Discard the change" does, and it is
    // also what releases the unlock they spent (the guard trigger's void branch).
    if (co.status !== "pending_ack" && co.status !== "draft") {
      return json({ error: co.status === "acknowledged" ? "This change order is already acknowledged — it can't be discarded." : "This change order is already voided." }, 400);
    }

    let reverted = false;
    // deno-lint-ignore no-explicit-any
    const before: any = co.snapshot_before;
    if (before && before.estimateLines) {
      const { data: d } = await admin.from("designs")
        .select("ss_quote_number, image_url, contact, items, custom_options, ro_dimensions, bldg_w, bldg_h, inventory_unit_id")
        .eq("client_id", clientId).eq("short_code", co.short_code).maybeSingle();
      const { error: restErr } = await admin.from("designs")
        .update({
          estimate_lines: before.estimateLines,
          // Reverting the lines reverts the value with them — a discarded change order must
          // not leave the card quoting the number it was discarded for.
          total_cents: designTotalCents(before.estimateLines),
          selections: before.selections ?? undefined,
          paint_colors: before.paintColors ?? undefined,
          updated_at: new Date().toISOString(),
        })
        .eq("client_id", clientId).eq("short_code", co.short_code);
      if (restErr) return dbFail(req, clientId, "restore the signed design", restErr);
      reverted = true;
      try {
        const { data: maxV } = await admin.from("design_versions").select("version")
          .eq("short_code", co.short_code).order("version", { ascending: false }).limit(1).maybeSingle();
        await admin.from("design_versions").insert({
          short_code: co.short_code, client_id: clientId, version: (Number(maxV?.version) || 0) + 1,
          contact: d?.contact, selections: before.selections, paint_colors: before.paintColors,
          items: d?.items, custom_options: d?.custom_options, ro_dimensions: d?.ro_dimensions,
          bldg_w: d?.bldg_w, bldg_h: d?.bldg_h, image_url: d?.image_url,
          inventory_unit_id: d?.inventory_unit_id ?? null,
        });
      } catch (_e) { /* bookkeeping */ }
      if (d?.ss_quote_number) {
        await regenerateQuotePdf(admin, req, clientId, co.short_code, {
          quoteNumber: String(d.ss_quote_number), snap: before.estimateLines, planUrl: d.image_url,
        });
      }
    }

    const { data: voided, error: voidErr } = await admin.from("change_orders")
      .update({ status: "void", void_reason: reason })
      // Both live states: the guard above already refused anything else, and a DRAFT is the
      // common case now — "Discard the change" is a rep throwing away their own workspace,
      // and it is what hands back the unlock they spent. Left at pending_ack alone, the
      // action returned a cheerful 200 having changed nothing (found in verification).
      .eq("id", co.id).in("status", ["draft", "pending_ack"])
      // .select() so a conditional update that matched NOTHING is an answer, not a silent
      // success — ChangeOrdersCard's recordVerbal carries the same guard for the same reason
      // (portal/04-orders.jsx). Without it this returned 200 while the change order sat
      // untouched and the unlock stayed spent.
      .select("id");
    if (voidErr) return dbFail(req, clientId, "void the change order", voidErr);
    if (!voided || voided.length === 0) {
      return json({ error: "That change moved while you were looking at it — reload the order." }, 409);
    }
    return json({ ok: true, reverted, coNo: co.co_no });
  }

  // ── "Not now" on an invoice request (migration 229) ─────────────────────────────────────
  // Ahsan, 2026-09-15: a customer's Accept raises a DRAFT invoice and the builder approves it
  // with one click. Approving has no action of its own — it IS send_invoice below, which
  // answers the request when it records the invoice. This is the other answer: the builder
  // is not issuing it yet (a deposit agreed by phone, a customer who wants a change first).
  //
  // It issues, numbers, voids and emails nothing, and the acceptance is untouched. The order
  // stays accepted and drops back to "Needs invoice" on the Orders tab, because the column the
  // tab reads (ss_invoice_requested_at) is cleared — so issuing later is still one click.
  if (action === "dismiss_invoice_request") {
    const shortCode = String(payload?.shortCode ?? "").trim();
    if (!shortCode) return json({ error: "shortCode is required." }, 400);
    // ROW SCOPE (207), exactly as send_invoice: a rep on contacts:'own' holding orders:edit
    // may only set aside requests from their own customers.
    { const refused = await refuseUnlessDesignVisible(shortCode); if (refused) return refused; }
    // The reason is for the team, never the customer — customer-quotes projects the status
    // alone. Flattened and capped like the other free text this function stores.
    const note = String(payload?.note ?? "").replace(/\s+/g, " ").trim().slice(0, 500) || null;

    const { data: row, error: readErr } = await admin.from("invoice_requests")
      .select("status").eq("client_id", clientId).eq("short_code", shortCode).maybeSingle();
    if (readErr) return dbFail(req, clientId, "read that invoice request", readErr);
    if (!row) return json({ error: "There's no invoice request waiting on that order." }, 404);
    if (row.status === "approved") return json({ error: "That invoice has already been issued." }, 409);
    // THE INVOICE OUTRANKS THE REQUEST ROW (review, 2026-09-15). send_invoice answers the request
    // best-effort after the invoice is recorded; when that write misses (logged as
    // invoice_request_approve) the row still says 'pending' beside an issued invoice. Asking the
    // invoice itself keeps "Not now" off an order whose invoice is already out: the stamp the
    // Orders tab reads, or an invoice_sends row that completed ('created' = issued, email pending).
    const [stampRes, sendRes] = await Promise.all([
      admin.from("designs").select("ss_invoice_sent_at")
        .eq("client_id", clientId).eq("short_code", shortCode).maybeSingle(),
      admin.from("invoice_sends").select("status")
        .eq("client_id", clientId).eq("short_code", shortCode).maybeSingle(),
    ]);
    if (stampRes.error) return dbFail(req, clientId, "read the order's invoice state", stampRes.error);
    if (sendRes.error) return dbFail(req, clientId, "read the order's invoice", sendRes.error);
    if (stampRes.data?.ss_invoice_sent_at || ["created", "sent"].includes(String(sendRes.data?.status ?? ""))) {
      return json({ error: "That invoice has already been issued." }, 409);
    }
    if (row.status === "pending") {
      // Guarded on status, so a send that lands between the read and this write wins: an
      // issued invoice must never be relabelled as set aside.
      const { data: upd, error: updErr } = await admin.from("invoice_requests")
        .update({
          status: "dismissed",
          decided_at: new Date().toISOString(),
          decided_by_user_id: operator ? null : (userId ?? null),
          decided_by_operator: operator ? operator.email : null,
          dismiss_note: note,
        })
        .eq("client_id", clientId).eq("short_code", shortCode).eq("status", "pending")
        .select("status");
      if (updErr) return dbFail(req, clientId, "set that invoice request aside", updErr);
      if (!upd?.length) return json({ error: "That request changed while you were looking at it — refresh the order." }, 409);
    }
    // Cleared on the already-dismissed path too, so a retry after a failed clear repairs it.
    const { error: clrErr } = await admin.from("designs")
      .update({ ss_invoice_requested_at: null })
      .eq("client_id", clientId).eq("short_code", shortCode);
    if (clrErr) return dbFail(req, clientId, "update the order's invoice state", clrErr);
    // The note stays out of the audit line: it is free text about a customer.
    audit("dismiss_invoice_request", null, `short_code=${shortCode}`);
    return json({ ok: true, status: "dismissed", ...(row.status === "dismissed" ? { already: true } : {}) });
  }

  // push_to_invoice rides this same handler on purpose. It is send_invoice with ONE extra
  // step in front of it — the rep-attested acceptance, migration 178 — and everything after
  // that step must be the same code, not a copy of it: the claim ladder, the number
  // allocation, the amendment math, the PDF and the email are the parts that are hard to get
  // right, and a second implementation of them is a second thing to keep correct. The extra
  // step is inserted immediately above the acceptance gate below; the gate itself is
  // untouched and simply passes, because by then the acceptance is real.
  if (action === "send_invoice" || action === "push_to_invoice") {
    const pushToInvoice = action === "push_to_invoice";
    const shortCode = String(payload?.shortCode ?? "").trim();
    if (!shortCode) return json({ error: "shortCode is required." }, 400);
    // ROW SCOPE (207). A rep on contacts:'own' may hold designs:edit / orders:edit and
    // still not be allowed near THIS customer's building. The gate above decides what
    // KIND of thing they may do; this decides which rows. Placed before the design is
    // even read, so a refusal costs nothing and cannot leak timing.
    { const refused = await refuseUnlessDesignVisible(shortCode); if (refused) return refused; }

    // An operator is emailing a real invoice to SOMEONE ELSE'S customer. Two extra
    // conditions, neither of which applies to a tenant sending their own:
    //   1. An explicit confirmation in the body. portal.html already shows a confirm
    //      dialog, but that is client-side only and a mis-scoped script must not be able
    //      to email a stranger's customers.
    //   2. A durable audit row written BEFORE the irreversible convert below. This is
    //      auditStrict, not the best-effort audit used for reads: if we cannot record who
    //      triggered it, we do not trigger it.
    if (operator) {
      if (payload?.confirmSend !== true) {
        return json({ error: "Operator sends require explicit confirmation (confirmSend)." }, 400);
      }
      try {
        // The action name rides in the audit row: a push ALSO attests the acceptance on the
        // customer's behalf, so "an operator invoiced a stranger's customer" and "an
        // operator declared a stranger's customer had agreed" must not read the same later.
        await auditStrict(`operator_${action}_attempt`, null, `short_code=${shortCode}`);
      } catch (e) {
        return json({ error: (e as Error).message }, 503);
      }
    }

    // ── SS MODE (migration 125): StructureStudio issues the invoice ──────────────────
    // One early-return branch, exactly the submit-estimate 9-ALT pattern: the entire GHL
    // convert/send machinery below stays byte-identical for every invoice_in_ghl tenant.
    {
      const { data: cur0 } = await admin.from("client_settings")
        .select("invoice_in_ghl, business_name, business_phone, business_website, business_logo_url, business_address, quote_terms")
        .eq("client_id", clientId).maybeSingle();
      if (cur0?.invoice_in_ghl === false) {
        // The design: the SS quote is the prerequisite, and the acceptance evidence is OUR
        // OWN record (designs.status/accepted_at written by customer-accept, migration 124)
        // — there is no live GHL estimate to check.
        const { data: d, error: dErr } = await admin.from("designs")
          // selections/paint_colors/contact are read ONLY for the push_to_invoice
          // attestation below (the accepted_snapshot stamp and the phone precondition) and
          // are untouched on the ordinary send_invoice path. That is a deliberate narrowing
          // of the 2026-08-07 rule "no dead PII reads on the invoice path": the read is not
          // dead here, it is the evidence. Nothing below logs any of the three.
          // updated_at is the attestation's compare-and-swap token (see its promote below).
          .select("short_code, status, accepted_at, updated_at, ss_quote_number, ss_quote_pdf_url, image_url, estimate_lines, accepted_snapshot, selections, paint_colors, contact, inventory_unit_id")
          .eq("client_id", clientId).eq("short_code", shortCode).maybeSingle();
        if (dErr) return dbFail(req, clientId, "find that design", dErr);
        if (!d) return json({ error: "Design not found." }, 404);
        if (!d.ss_quote_number) return json({ error: "This design has no quote yet — submit it from the designer first." }, 400);

        // The order this invoice belongs to, for the caller to navigate to. The portal's
        // order deep link is /portal/orders/o-<orders.id>, keyed on the UUID and not on
        // order_no, so the id is what has to travel back. Best-effort by contract: an invoice
        // that went out is not undone by our failing to say where it landed, so every caller
        // treats a null orderId as "no link", never as an error.
        const loadOrderRef = async (): Promise<{ orderId: string | null; orderNo: number | null }> => {
          try {
            const { data: o } = await admin.from("orders").select("id, order_no")
              .eq("client_id", clientId).eq("short_code", shortCode).maybeSingle();
            return { orderId: o?.id ?? null, orderNo: o?.order_no ?? null };
          } catch (_) {
            return { orderId: null, orderNo: null };
          }
        };

        // THE AGREED LINES — what this branch bills from (2026-09-07).
        //
        // `estimate_lines` is the LIVE design and a rep rewrites it the moment they stage a
        // change; `accepted_snapshot` (migration 153) is the design as the customer last
        // agreed it, re-stamped by the trigger on every acknowledged change. Billing from the
        // live copy meant a staged-but-unapproved revision could reach an invoice, a
        // regenerated PDF and the sentence the customer signs.
        //
        // In the settled state the two are the same object — verified against live, where
        // every design without an open change order matched exactly — so this changes nothing
        // on the ordinary path. The push_to_invoice attestation below deliberately keeps
        // reading `d.estimate_lines`: it is PERFORMING the acceptance, not billing one.
        // `let`: when a customer's acceptance wins the race with a push, the attestation below
        // re-reads THEIR frozen snapshot and bills that instead of this read.
        let agreedLines = agreedBaseline(d).lines;

        // AMENDMENTS (2026-08-27). A manual change order moves the TOTAL without touching
        // estimate_lines, so a document built from the snapshot alone bills the pre-change
        // amount — see amendedInvoiceDocument's header for the case that proved it. Both
        // the PDF below and the email-retry branch just under here read from this, so a
        // re-send can never name a different number than the document it links to.
        // A missing change_orders table is tolerated exactly as the pending check does.
        // THE FEE COLUMNS ARE NOT OPTIONAL HERE (2026-09-07). The acknowledging writer adds the
        // fee to orders.pretax_subtotal_cents, which is the figure handed to the reconciler
        // below. Select the fee and it prints as the line the tenant named; omit it and the
        // order looks unexplained by exactly the fee, so the reconciler invents an anonymous
        // "Order adjustment" row for it on the customer's invoice. fee_label is not a column on
        // change_orders — the tenant names their own fee once, in settings — so it is joined on
        // here rather than denormalised onto every row.
        const loadAmendments = async (): Promise<{ acked: any[]; orderTotalCents: number | null }> => {
          const [coRes, ordRes, feeRes] = await Promise.all([
            admin.from("change_orders")
              .select("co_no, description, total_before_cents, total_after_cents, fee_cents, fee_tax_cents, fee_taxable")
              .eq("client_id", clientId).eq("short_code", shortCode).eq("status", "acknowledged"),
            admin.from("orders").select("total_cents, pretax_subtotal_cents")
              .eq("client_id", clientId).eq("short_code", shortCode).maybeSingle(),
            admin.from("client_settings").select("co_fee_label").eq("client_id", clientId).maybeSingle(),
          ]);
          const feeLabel = String(feeRes.data?.co_fee_label ?? "").trim() || "Change order fee";
          // PRE-TAX, deliberately (migration 148). amendedInvoiceDocument reconciles its lines
          // against this in SUBTOTAL space — `sum(qty x amount) - discount`, the PDF's own
          // arithmetic — and since 148 the PDF adds a tax row ON TOP of that sum. orders
          // .total_cents is tax-INCLUSIVE for an SS order, so handing it over would leave the
          // two disagreeing by exactly the tax, and the reconciler would invent a balancing
          // "Change order" line worth the sales tax on every invoice. pretax_subtotal_cents is
          // written beside total_cents by the same helper, so the pair cannot drift; it falls
          // back to total_cents only for an untaxed order, where the two are equal anyway.
          const ord = ordRes.error ? null : ordRes.data;
          const pretax = ord?.pretax_subtotal_cents ?? ord?.total_cents ?? null;
          return {
            acked: coRes.error ? [] : (coRes.data ?? []).map((c) => ({ ...c, fee_label: feeLabel })),
            orderTotalCents: pretax == null ? null : Number(pretax),
          };
        };

        // ── THE FIGURE THE EMAIL NAMES ────────────────────────────────────────────────
        // "Amount due" in the invoice email has to be the number printed on the invoice, and
        // since migration 148 that is not what amountOwed() returns here. The two moved apart
        // for a good reason and the fix is not to move them back: loadAmendments hands the
        // reconciler the PRE-TAX order figure, because the PDF adds its tax row ON TOP of the
        // lines it foots (estimateLines.ts' contract, pinned by its tests) — so the document
        // total is amended-subtotal + tax while the email was quoting amended-subtotal alone.
        // On a taxed order the customer therefore read one number in the mail, a bigger one on
        // the attachment, and signed for a third.
        //
        // Built from the SAME call the PDF uses, so there is one arithmetic and not two. The
        // tax is never a re-resolved rate — amendedTax carries the accepted amount forward and
        // adds only the increment — and a snapshot with no tax returns null, leaving this the
        // old number exactly. Null stays null: "nothing to go on" renders as a blank rather
        // than a fabricated $0.00.
        //
        // ⛔ NOT a change to amountOwed or amendedInvoiceDocument. customer-quotes and
        // customer-accept pass those helpers the tax-INCLUSIVE orders.total_cents and land on
        // the right figure through the reconciler; moving either would move the number the
        // customer signs. This is the caller that had the wrong input, not the helper.
        //
        // 2026-09-07: the tax now comes from the SAME amendedInvoiceDocument call rather than
        // from the snapshot beside it. `taxFromSnapshot` is the tax on the ACCEPTED lines, so
        // on an amended order the email quoted the accepted tax against an amended subtotal
        // and under-stated the bill by the tax on the change. One call, one arithmetic — which
        // is the whole reason this helper exists.
        const emailAmountDue = (
          // deno-lint-ignore no-explicit-any
          acked: any[],
          orderTotalCents: number | null,
        ): number | null => {
          const doc = amendedInvoiceDocument(agreedLines, acked, orderTotalCents);
          const owed = amountOwed(agreedLines, acked, orderTotalCents);
          if (owed == null) return null;
          return Math.round((owed + (Number(doc.tax?.amount) || 0)) * 100) / 100;
        };

        // `let`, not `const`: the push_to_invoice attestation below promotes the design and
        // then brings this local up to what it wrote, so the acceptance gate reads the truth.
        let dStatus = String(d.status || "");
        if (dStatus === "invoiced" || dStatus === "delivered") {
          // The invoice may have completed on paper (the email does not gate it — see
          // below). If the ledger says created-but-never-emailed, this click is the email
          // retry; anything else is genuinely done.
          const { data: prior } = await admin.from("invoice_sends")
            .select("status, issued_by, invoice_number, invoice_pdf_url")
            .eq("client_id", clientId).eq("short_code", shortCode).maybeSingle();
          if (prior && String(prior.status) === "created" && String(prior.issued_by) === "structurestudio" && prior.invoice_number) {
            const { data: c2 } = await admin.from("designs").select("contact")
              .eq("client_id", clientId).eq("short_code", shortCode).maybeSingle();
            const to2 = String((c2?.contact as { email?: unknown } | null)?.email ?? "").trim();
            if (!isEmail(to2)) {
              return json({ error: `Invoice ${prior.invoice_number} is complete, but this design has no email address — print the invoice PDF instead.`, invoiceNumber: prior.invoice_number, invoicePdfUrl: prior.invoice_pdf_url, sent: false }, 400);
            }
            const { data: cs2 } = await admin.from("client_settings")
              .select("business_name, business_phone, business_website, business_logo_url, quote_terms, beta_mode, beta_email")
              .eq("client_id", clientId).maybeSingle();
            // A PLACEHOLDER ADDRESS (example.com, .test, ...) can never receive this, and the
            // provider's rejection used to come back here as a 502 fault row reading only
            // "(failed)". Decided from the address, before any send: the provider's 422 is a
            // request-shape error, not a recipient verdict, so it cannot tell this apart from
            // a real code fault. Paper-first, like the first send: the invoice stands, 200
            // sent:false, same shape as the success return below so every caller (including
            // the designer's navigation off orderId) keeps working. Skipped while beta mode
            // redirects the send to the tenant's test inbox — that address is the real one.
            // No address in the log row.
            const betaRedirect2 = cs2?.beta_mode === true && String(cs2?.beta_email ?? "").trim() !== "";
            if (!betaRedirect2 && isPlaceholderRecipient(to2)) {
              await logEdgeError({
                fn: "portal-settings", req, clientId, severity: "info", code: "invoice_email_placeholder",
                message: "Invoice email retry skipped: the customer's email is a placeholder address",
                context: { shortCode, invoiceNumber: prior.invoice_number },
              });
              return json({
                ok: true, invoiceNumber: prior.invoice_number, invoicePdfUrl: prior.invoice_pdf_url,
                issuedBy: "structurestudio", sent: false, attested: false, quoteNumber: d.ss_quote_number,
                ...(await loadOrderRef()),
                emailReason: "the customer's email is a placeholder address — update it on the design, then send again",
              });
            }
            const amend2 = await loadAmendments();
            const out2 = await sendTenantEmail(admin, clientId, {
              kind: "invoice", shortCode, to: to2,
              ...invoiceEmail({
                businessName: String(cs2?.business_name ?? "").trim() || clientId,
                logoUrl: cs2?.business_logo_url, phone: cs2?.business_phone, website: cs2?.business_website,
                invoiceNumber: String(prior.invoice_number),
                // The same figure the document it links to prints — a re-send must never name
                // a different number than the original did.
                total: emailAmountDue(amend2.acked, amend2.orderTotalCents) ?? "",
                invoiceUrl: prior.invoice_pdf_url, quoteTerms: cs2?.quote_terms,
                signUrl: myQuotesUrl(clientId, req),
              }),
            });
            if (out2.sent) {
              await admin.from("invoice_sends").update({ status: "sent", error: null, updated_at: new Date().toISOString() })
                .eq("client_id", clientId).eq("short_code", shortCode);
              // taxCheck: an email retry of an invoice issued earlier makes no lookup (see the
              // invoice-time check at the end of this branch).
              return json({ ok: true, invoiceNumber: prior.invoice_number, invoicePdfUrl: prior.invoice_pdf_url, issuedBy: "structurestudio", sent: true, attested: false, quoteNumber: d.ss_quote_number, ...(await loadOrderRef()), taxCheck: { status: "skipped", reason: "reissue" } });
            }
            // A real send failure stays a 502 fault. The reason is a sentence, never the bare
            // status ("failed") and never the provider's raw string — that stays in
            // email_sends.error for triage.
            const why2 = out2.reason === "not_active"
              ? "email sending isn't switched on for this account yet"
              : "the email service didn't accept the send";
            return json({ error: `Invoice ${prior.invoice_number} exists but the email still didn't go out: ${why2}. Print the invoice PDF or fix email sending in Settings → Email.`, invoiceNumber: prior.invoice_number, invoicePdfUrl: prior.invoice_pdf_url, sent: false }, 502);
          }
          return json({ error: "This design was already invoiced." }, 400);
        }
        // ── PUSH TO INVOICE: the rep attests the acceptance (migration 178) ─────────────
        // Carolyn, 2026-09-01: the rep should be able to invoice straight off the designer
        // success screen without waiting for the customer to click Accept.
        //
        // This does NOT relax the gate below — it satisfies it. The gate is not a nuisance
        // check; it is the proxy for four things the ~250 lines under it assume exist: the
        // orders row, accepted_snapshot, orders.total_cents, and a design_acceptances row.
        // Issuing an invoice without them breaks five places at once and every one is
        // silent. The worst is accepted_snapshot: submit-estimate's 9-ALT change-order block
        // is gated on accepted_at, so a rep who revises AFTER invoicing would raise no
        // change order, and sign_invoice would then recompute the total from the NEW lines —
        // putting an amount on the countersigned certificate that is not the one on the
        // invoice PDF the customer is reading. No guard anywhere catches that, because the
        // staleness check compares a CO's acknowledged_at to the invoice and there is no CO.
        //
        // So: write a real acceptance, attributed to the rep and never dressed as the
        // customer's. Same posture as the verbal change-order acknowledgement (126).
        let attested = false;
        if (pushToInvoice && dStatus !== "accepted" && !d.accepted_at) {
          // A quote that already has a pending change order is already accepted, so this
          // branch cannot be reached with one outstanding — the 409 below still owns that
          // case, and reaching it means the design was accepted the ordinary way.
          const contact = (d.contact ?? {}) as Record<string, unknown>;
          const signerName = String(contact.name ?? "").trim();

          // The customer signs the invoice through a phone OTP session, and sign_invoice
          // compares phoneKey(contact.phone) against that session. Without a usable phone
          // the invoice could never be signed — while still spending an invoice number,
          // claiming the inventory unit and creating a QuickBooks invoice. Carolyn,
          // 2026-09-01: refuse outright rather than warn.
          const phoneDigits = phoneKey(contact.phone);
          if (phoneDigits.length < 10) {
            return json({ error: "This customer has no phone number on file, and they sign the invoice by text. Add their number to the contact first, then push it to an invoice." }, 400);
          }

          // Who is attesting. Read from client_users by the VERIFIED session's userId, never
          // from the body — the change_orders.verbal_recorded_by posture. Denormalised onto
          // the row because it is evidence: it must still read correctly after the user is
          // renamed or removed.
          let recordedByName = String(userEmail ?? "").trim();
          if (userId) {
            const { data: cu } = await admin.from("client_users")
              .select("full_name").eq("user_id", userId).maybeSingle();
            const fullName = String(cu?.full_name ?? "").trim();
            if (fullName) recordedByName = fullName;
          }
          if (!recordedByName) {
            // The rep_named CHECK would refuse the insert anyway; refuse here with a sentence
            // a person can act on instead of a constraint violation.
            return json({ error: "We couldn't tell who is issuing this invoice. Sign out and back in, then try again." }, 400);
          }

          const attestedAtIso = new Date().toISOString();
          const attestedTotal = totalFromSnapshot(d.estimate_lines);
          let designVersion: number | null = null;
          {
            const { data: v } = await admin.from("design_versions")
              .select("version").eq("short_code", shortCode)
              .order("version", { ascending: false }).limit(1).maybeSingle();
            designVersion = v?.version ?? null;
          }

          // The consent text is the durable evidence, so it is composed HERE and says what
          // actually happened. It must never read as though the customer agreed on their own
          // — the whole point of method='rep' is that the record is honest about who spoke.
          // Local rather than shared: this is the only money string portal-settings composes
          // (the PDFs and emails format their own), and it matches customer-accept's fmtMoney
          // output so the two consent sentences read alike in the evidence table.
          const money = (n: number) => {
            const v = Math.round(n * 100) / 100;
            const [int, frac] = Math.abs(v).toFixed(2).split(".");
            return `${v < 0 ? "-" : ""}$${int.replace(/\B(?=(\d{3})+(?!\d))/g, ",")}.${frac}`;
          };
          const consentText =
            `${recordedByName} issued invoice for quote ${d.ss_quote_number}` +
            (attestedTotal != null ? ` for ${money(attestedTotal)}` : "") +
            ` on the customer's behalf. The customer did not accept this quote electronically;` +
            ` their agreement is recorded when they sign the invoice.`;

          // Named, so a promote that loses the race below can withdraw exactly this row.
          const acceptanceId = crypto.randomUUID();
          const { error: attErr } = await admin.from("design_acceptances").insert({
            id: acceptanceId,
            client_id: clientId,
            short_code: shortCode,
            subject: "quote",
            quote_number: d.ss_quote_number,
            design_version: designVersion,
            total: attestedTotal,
            ...taxFreeze(d.estimate_lines),
            method: "rep",
            signer_name: signerName || "(no name on file)",
            consent_text: consentText,
            phone_digits: phoneDigits,
            recorded_by_user_id: userId ?? null,
            recorded_by_name: recordedByName,
            ip: clientIp(req),
            user_agent: (req.headers.get("user-agent") || "").slice(0, 300) || null,
            accepted_at: attestedAtIso,
          });
          if (attErr && String(attErr.code) !== "23505") {
            return dbFail(req, clientId, "record the invoice authorisation", attErr);
          }
          attested = !attErr;

          // 23505 on design_acceptances_quote_once = this quote was accepted between our read
          // and our write — the customer clicked Accept, or a second push landed. THEIRS is
          // the acceptance, and it has already promoted the design, stamped
          // accepted_snapshot, opened the order and filled the total. Writing ours on top
          // would move accepted_at to now and re-freeze the snapshot against lines they never
          // saw — overwriting real customer evidence with a rep's. So take none of the writes
          // below; just re-read what they wrote so the gate sees it, and invoice it.
          if (!attested) {
            // THEIR snapshot, not this read (review, 2026-09-17). customer-accept froze the lines
            // it read, and a re-price (Verify, a sales-location change) that landed after `d` was
            // read and before the customer's read is in their snapshot and not in `d`. Billing
            // agreedLines from `d` would invoice the pre-re-price total beside an agreement and
            // an order that say otherwise. So the snapshot comes back with the flags, and the
            // agreed lines follow it. No snapshot yet (their promote has not landed, or it was
            // withdrawn as a re-price) leaves accepted_at null, and the gate below refuses.
            const { data: fresh } = await admin.from("designs")
              .select("status, accepted_at, accepted_snapshot").eq("client_id", clientId).eq("short_code", shortCode).maybeSingle();
            d.accepted_at = fresh?.accepted_at ?? d.accepted_at;
            dStatus = String(fresh?.status || dStatus);
            if (fresh?.accepted_snapshot) {
              d.accepted_snapshot = fresh.accepted_snapshot;
              agreedLines = agreedBaseline(d).lines;
            }
            audit("push_to_invoice_raced", null, `short_code=${shortCode} — accepted concurrently, kept their acceptance`);
          } else {

            // Promote the design. accepted_snapshot (153) is the frozen agreement every later
            // change order diffs against — the single most important write in this block.
            //
            // A COMPARE-AND-SWAP, the same one customer-accept promotes with (review,
            // 2026-09-17). `d` was read before the version read, the attester lookup and the
            // insert above, and a rep's re-price can land in between: restampQuoteTax finds no
            // acceptance and no order yet, writes new lines and emails the customer the new
            // total. The promote used to be unguarded, so it then froze the OLD lines as the
            // agreement, filled the order from them and invoiced them. Now it swaps on the
            // updated_at `d` was read with (designs_set_updated_at bumps it on every update)
            // with accepted_at still null, which is the guard restampQuoteTax writes with, so
            // whichever of the two lands second matches no row. On a miss, promoteMiss (the
            // customer-accept one) reads why:
            //   repriced: the total is not the one attested. Withdraw the acceptance just
            //     recorded and refuse, naming the current total. Nothing refers to that row yet:
            //     the order, the invoice number, the PDF and the email all come later;
            //   retry: the total is the one attested. An unrelated write moved updated_at, or a
            //     re-stamp changed words but not money. Swap against the new value, a bounded
            //     number of times;
            //   stop, or retries spent: withdraw and refuse too. Left behind, a rep acceptance
            //     with no promote reads as agreement to every re-price (refuseIfAgreed) and
            //     answers the customer's own Accept with "already accepted".
            {
              const patch: Record<string, unknown> = {
                accepted_at: attestedAtIso,
                updated_at: attestedAtIso,
                accepted_snapshot: {
                  estimateLines: d.estimate_lines,
                  selections: d.selections,
                  paintColors: d.paint_colors,
                },
              };
              if (dStatus === "sent" || dStatus === "") patch.status = "accepted";
              const PROMOTE_ATTEMPTS = 3;
              let casUpdatedAt: string | null = typeof d.updated_at === "string" ? d.updated_at : null;
              let missRefusal: Response | null = null;
              for (let attempt = 1; attempt <= PROMOTE_ATTEMPTS; attempt++) {
                let promote = admin.from("designs").update(patch)
                  .eq("client_id", clientId).eq("short_code", shortCode).is("accepted_at", null);
                promote = casUpdatedAt ? promote.eq("updated_at", casUpdatedAt) : promote.is("updated_at", null);
                const { data: promoted, error: promErr } = await promote.select("short_code");
                // Not best-effort: without accepted_at the gate below refuses, and without the
                // snapshot the change-order baseline is missing — which is the bug this whole
                // block exists to prevent. Refuse before anything irreversible happens.
                if (promErr) return dbFail(req, clientId, "record the acceptance", promErr);
                if (Array.isArray(promoted) && promoted.length === 1) break;

                const { data: now, error: nowErr } = await admin.from("designs")
                  .select("estimate_lines, accepted_at, updated_at")
                  .eq("client_id", clientId).eq("short_code", shortCode).maybeSingle();
                const miss = nowErr ? null : promoteMiss(d.estimate_lines, now);
                if (miss?.kind === "retry" && attempt < PROMOTE_ATTEMPTS) {
                  casUpdatedAt = miss.updatedAt;
                  continue;
                }
                if (miss?.kind === "repriced") {
                  const cents = miss.body.totalCents;
                  missRefusal = json({
                    error: `This quote's total changed${cents == null ? "" : ` to ${money(cents / 100)}`} while the invoice was being issued, so nothing was issued. Check the quote, then push it to an invoice again.`,
                    reason: "repriced",
                    totalCents: cents,
                  }, 409);
                  audit("push_to_invoice_repriced", null, `short_code=${shortCode}`);
                } else {
                  missRefusal = json({
                    error: "This quote changed while the invoice was being issued, so nothing was issued. Reload it and try again.",
                    reason: "changed",
                  }, 409);
                  const why = nowErr ? `re-read failed: ${nowErr.message}` : miss?.kind === "stop" ? miss.why : "the design kept changing";
                  logEdgeError({ fn: "portal-settings", req, clientId, code: 500, message: `push_to_invoice promote did not land: ${why}`, context: { shortCode, attempt } }).catch(() => {});
                }
                break;
              }
              if (missRefusal) {
                const { error: withdrawErr } = await admin.from("design_acceptances").delete()
                  .eq("id", acceptanceId).eq("client_id", clientId);
                if (withdrawErr) {
                  // The rep acceptance stands for a promote that never happened. Support removes
                  // it by hand; this is the only trace.
                  logEdgeError({ fn: "portal-settings", req, clientId, code: "attest_withdraw_failed", message: `push_to_invoice acceptance withdraw failed: ${withdrawErr.message}`, context: { shortCode, acceptanceId } }).catch(() => {});
                }
                return missRefusal;
              }
            }

            // The order row. The designs_ensure_order trigger fires on the status change where
            // it exists, but its CREATE lives on the wip/orders branch, so the flow must not
            // depend on it — same idempotent shape customer-accept uses.
            const { error: ordErr } = await admin.from("orders").upsert(
              { client_id: clientId, short_code: shortCode, ordered_at: attestedAtIso },
              { onConflict: "client_id,short_code", ignoreDuplicates: true },
            );
            if (ordErr) return dbFail(req, clientId, "open the order", ordErr);
            if (attestedTotal != null) {
              // NULL-only: a rep-set total is never clobbered.
              const { error: totErr } = await admin.from("orders")
                .update({ ...orderMoneyCols(d.estimate_lines, attestedTotal), total_source: "manual", updated_at: attestedAtIso })
                .eq("client_id", clientId).eq("short_code", shortCode).is("total_cents", null);
              if (totErr) {
                logEdgeError({ fn: "portal-settings", req, clientId, code: 500, message: `push_to_invoice order total fill failed: ${totErr.message}`, context: { shortCode } }).catch(() => {});
              }
            }

            // `d` was read before all of the above, so the gate immediately below would still
            // refuse on the stale copy. Bring the locals up to what was just written.
            d.accepted_at = attestedAtIso;
            if (dStatus === "sent" || dStatus === "") dStatus = "accepted";
            audit("push_to_invoice_attested", null, `short_code=${shortCode} quote=${d.ss_quote_number} by=${recordedByName}`);
          } // end: we won the acceptance claim
        }

        if (dStatus !== "accepted" && !d.accepted_at) {
          return json({ error: `The customer hasn't accepted this quote yet (status: ${dStatus || "sent"}). They accept it from their quote page, then you invoice them and they sign that.` }, 400);
        }

        // Pending change order blocks invoicing (Carolyn 2026-08-23). 42P01 = the
        // change_orders table hasn't shipped yet — treat as no pending, so this branch and
        // the change-orders slice can deploy in either order.
        {
          const co = await admin.from("change_orders").select("id")
            .eq("client_id", clientId).eq("short_code", shortCode).eq("status", "pending_ack").limit(1);
          // A missing table is fine (the change-orders slice may not have shipped yet):
          // raw Postgres says 42P01, but PostgREST reports it as PGRST205 ("could not find
          // the table ... in the schema cache") — tolerate both spellings.
          const missingTable = co.error && (
            String(co.error.code) === "42P01" || String(co.error.code) === "PGRST205" ||
            /does not exist|schema cache/i.test(String(co.error.message || ""))
          );
          if (co.error && !missingTable) return dbFail(req, clientId, "check change orders", co.error);
          if (!co.error && (co.data?.length ?? 0) > 0) {
            return json({ error: "A change order on this job is awaiting the customer's acknowledgment. Invoice it after they sign, or record their verbal confirmation on the order." }, 409);
          }
        }

        const nowIso = () => new Date().toISOString();
        const setClaim = async (patch: Record<string, unknown>) => {
          const r = await admin.from("invoice_sends").update({ ...patch, updated_at: nowIso() })
            .eq("client_id", clientId).eq("short_code", shortCode);
          // Mirror the invoicer onto the design (migration 207) whenever this patch sets one.
          // The board reads `designs` over PostgREST and cannot see invoice_sends at all, so
          // this copy is the only way "invoiced by" reaches the Pipeline. Best-effort: the
          // invoice is the real work and must never fail over an attribution write.
          if (Object.prototype.hasOwnProperty.call(patch, "sender_user_id")) {
            const who = operator ? null : (patch.sender_user_id ?? null);
            await admin.from("designs").update({ invoiced_by_user_id: who })
              .eq("client_id", clientId).eq("short_code", shortCode)
              .then(() => undefined, () => undefined);
          }
          return r;
        };
        const STALE_CLAIM_MS = 3 * 60 * 1000;

        // Claim — same PK-insert concurrency claim and recovery ladder as the CRM path.
        let recoveredNumber: string | null = null;
        let recoveredPdfUrl: string | null = null;
        const claimIns = await admin.from("invoice_sends").insert({
          client_id: clientId, short_code: shortCode,
          issued_by: "structurestudio", status: "claimed", attempts: 1,
          sent_by_operator: operator ? operator.email : null,
          // Who raised it. The GHL branch has always written this; the SS branch never did,
          // so every StructureStudio-issued invoice has had a null commission earner
          // (portal-commissions reads invoice_sends.sender_user_id). Putting a rep-initiated
          // invoice button in the designer is the moment that stops being theoretical.
          sender_user_id: userId ?? null,
          invoice_type: invoiceTypeFor(d),
        });
        if (claimIns.error) {
          const { data: prior } = await admin.from("invoice_sends")
            .select("status, issued_by, invoice_number, invoice_pdf_url, updated_at, attempts, signed_at")
            .eq("client_id", clientId).eq("short_code", shortCode).maybeSingle();
          if (!prior) return dbFail(req, clientId, "start the invoice send", claimIns.error);
          const st = String(prior.status || "");
          // SIGNED PAPERWORK IS FROZEN — the one refusal that outranks everything below.
          if (prior.signed_at) {
            return json({ error: `Invoice ${prior.invoice_number ?? ""} has already been signed by the customer.` }, 400);
          }
          if (st === "sent") {
            // Before migration 136 this was the end of the road: sent meant done. Now the
            // customer still has to SIGN, so an unsigned invoice has to stay re-sendable —
            // a lost email would otherwise strand the order with no operator remedy at all.
            recoveredNumber = prior.invoice_number ? String(prior.invoice_number) : null;
            recoveredPdfUrl = prior.invoice_pdf_url ? String(prior.invoice_pdf_url) : null;
          } else if (st === "created") {
            // The invoice EXISTS (number + document) but was never emailed → re-send only.
            recoveredNumber = prior.invoice_number ? String(prior.invoice_number) : null;
            recoveredPdfUrl = prior.invoice_pdf_url ? String(prior.invoice_pdf_url) : null;
          } else if (st === "claimed") {
            const age = Date.now() - new Date(String(prior.updated_at)).getTime();
            if (age < STALE_CLAIM_MS) {
              return json({ error: "An invoice for this design is already being sent — give it a moment." }, 409);
            }
          }
          await setClaim({ status: st === "created" ? "created" : "claimed", issued_by: "structurestudio", error: null, attempts: (Number(prior.attempts) || 1) + 1 });
          // REGENERATE: an acknowledged change order after the invoice went out means the
          // amount printed on it is no longer the amount owed, and the customer's sign
          // button refuses a stale invoice for exactly that reason. Dropping the recovered
          // URL sends the builder below down the build path again, which upserts the SAME
          // storage path under the SAME number — a corrected document, not a second invoice.
          if (payload.regenerate === true) recoveredPdfUrl = null;
        }

        // Number — allocated ONCE; the recovery path reuses it, never re-numbers.
        let invNumber = recoveredNumber;
        if (!invNumber) {
          const { data: allocated, error: allocErr } = await admin
            .rpc("allocate_ss_invoice_number", { p_client_id: clientId });
          if (allocErr) {
            await setClaim({ status: "failed", error: `allocate: ${allocErr.message}`.slice(0, 500) });
            return json({ error: `Could not allocate an invoice number: ${allocErr.message}` }, 502);
          }
          invNumber = allocated ? String(allocated) : null;
          if (!invNumber) {
            await setClaim({ status: "failed", error: "no invoice starting number" });
            return json({ error: "No starting invoice number is set. Add one in Settings → CRM Connection → Quotes & Invoices." }, 400);
          }
        }

        // The document: the same 3-sheet builder as the quote, titled Invoice (docKind).
        // Best-effort — a PDF failure records honestly and the invoice still sends, the
        // same contract as the quote path.
        let invoicePdfUrl = recoveredPdfUrl;
        // The bill is the ORDER's total, not the quote snapshot's: acknowledged change
        // orders become real lines so the document both foots and explains itself.
        const amend = await loadAmendments();
        const amended = amendedInvoiceDocument(agreedLines, amend.acked, amend.orderTotalCents);
        // ⚠️ TWO FIGURES, AND THEY ARE NOT INTERCHANGEABLE — read this before touching either.
        //   totalNum   the reconciled PRE-TAX total: what the PDF's line items foot to, which
        //              is what the ledger write below feeds (orderMoneyCols derives the
        //              tax-inclusive orders.total_cents from the snapshot itself and only
        //              falls back to this when there is no snapshot to derive from).
        //   emailTotal the same total WITH the accepted tax added — the figure the PDF
        //              actually prints, and therefore the only one the email may quote.
        const totalNum = amountOwed(agreedLines, amend.acked, amend.orderTotalCents);
        const emailTotal = emailAmountDue(amend.acked, amend.orderTotalCents);
        if (!invoicePdfUrl) {
          try {
            const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
            const expectedPdfPrefix = `${supabaseUrl}/storage/v1/object/public/floor-plans/${clientId}/`;
            const planUrl = d.image_url && String(d.image_url).startsWith(expectedPdfPrefix) ? String(d.image_url) : null;
            const snapLines = amended.lines;
            const pdfBytes = await buildQuotePdf({
              docKind: "invoice",
              business: {
                name: String(cur0?.business_name ?? "").trim() || clientId,
                phone: cur0?.business_phone ?? null,
                website: cur0?.business_website ?? null,
                address: cur0?.business_address ?? null,
              },
              estimateNumber: invNumber,
              dateIso: nowIso(),
              // deno-lint-ignore no-explicit-any
              lines: snapLines.map((l: any) => ({ ...l, desc: deHtml(String(l?.desc ?? "")) })),
              discount: amended.discount,
              // The tax carried on the snapshot — the figure the customer ACCEPTED. The invoice
              // deliberately does NOT re-resolve the rate: acceptance is a click on a stated
              // total, and quietly billing a different one because a rate moved in between is
              // the change-order case, not a re-render.
              //
              // It rides ON TOP of amendedInvoiceDocument's reconciled lines, which is why
              // loadAmendments now hands that function the PRE-TAX order figure — see there.
              //
              // 2026-09-07: `amended.tax`, NOT `d.estimate_lines.tax`. estimatePdf's grand
              // total is the tax object's POOLS, not a sum of the lines it prints — so every
              // line amendedInvoiceDocument adds was printed here and then silently left out
              // of the Total. Its `amendedTax` moves the pools over those lines and adds only
              // the increment, leaving the accepted amount exactly as the customer agreed it.
              tax: amended.tax,
              discountRows: agreedLines?.discounts?.rows ?? null,
              quoteTerms: cur0?.quote_terms ?? null,
              planPdfUrl: planUrl,
            });
            const pdfPath = `${clientId}/${shortCode}-invoice.pdf`;
            const up = await admin.storage.from("floor-plans")
              .upload(pdfPath, pdfBytes, FIXED_PATH_PDF_UPLOAD);
            if (!up.error) {
              const { data: pub } = admin.storage.from("floor-plans").getPublicUrl(pdfPath);
              invoicePdfUrl = pub?.publicUrl || null;
            } else {
              console.warn("SS invoice PDF upload failed:", up.error.message);
            }
          } catch (e) {
            console.warn("SS invoice PDF generation failed:", (e as Error).message);
          }
        }

        // Record BEFORE the email: from here a retry re-sends this exact number + document.
        //
        // ⚠️ AND THE RESULT IS CHECKED. This write is what makes the number real — the ledger
        // row is the only place an issued invoice number is recorded — and it is the one write
        // in this branch that can be REFUSED: migration 125's partial unique index on
        // (client_id, invoice_number) fires when the number has already gone out on another
        // design, which is what a numbering counter set back below what has been issued
        // produces. Ignored, the customer received an invoice carrying a number the books do
        // not have and the next send would hand out the same one again. Nothing has left the
        // building at this point — the PDF is written, the email is still below — so this is
        // the last moment a collision can be refused instead of delivered.
        //
        // The recovery ladder is untouched by this: 'created' and 'sent' rows re-send with
        // their OWN stored number, so this update sets the value the row already holds and
        // cannot collide with itself.
        const recorded = await setClaim({ status: "created", issued_by: "structurestudio", invoice_number: invNumber, invoice_pdf_url: invoicePdfUrl, error: null });
        if (recorded.error) {
          const collision = String((recorded.error as { code?: string }).code ?? "") === "23505";
          // Park the failure on the row WITHOUT the number, so this update cannot hit the same
          // index. Best-effort: the refusal below is the outcome either way.
          await setClaim({ status: "failed", error: `record: ${recorded.error.message}`.slice(0, 500) });
          logEdgeError({
            fn: "portal-settings", req, clientId,
            code: collision ? "ss_invoice_number_collision" : "ss_invoice_record_failed",
            message: `invoice ${invNumber} could not be recorded for ${shortCode}: ${recorded.error.message}`,
          }).catch(() => {});
          return json({
            error: collision
              ? `Invoice number ${invNumber} has already been used on another invoice for this account, so nothing was sent. Raise the starting invoice number in Settings → CRM Connection → Quotes & Invoices, then send it again.`
              : "The invoice couldn't be recorded, so nothing was sent to your customer. Try again — if it keeps happening, tell CSM Synergy.",
            invoiceNumber: invNumber, invoicePdfUrl, sent: false,
          }, collision ? 409 : 502);
        }

        // (The `tax_invoice` charge that sat here until 2026-09-17 billed when the AGREED tax had
        // come from Avalara, with no call behind it. It is gone: the invoice meter now charges
        // only for the invoice-time lookup below, keyed on that lookup's ledger row.)

        // The email. Contact read only here (the PII discipline of 2026-08-07). There is
        // NO GHL fallback in SS mode — there is no GHL invoice object to email.
        const { data: c } = await admin.from("designs").select("contact")
          .eq("client_id", clientId).eq("short_code", shortCode).maybeSingle();
        const to = String((c?.contact as { email?: unknown } | null)?.email ?? "").trim();
        let sent = false;
        let sendReason: string | null = null;
        if (isEmail(to)) {
          const out = await sendTenantEmail(admin, clientId, {
            kind: "invoice",
            shortCode,
            to,
            ...invoiceEmail({
              businessName: String(cur0?.business_name ?? "").trim() || clientId,
              logoUrl: cur0?.business_logo_url,
              phone: cur0?.business_phone,
              website: cur0?.business_website,
              invoiceNumber: invNumber,
              // emailTotal, NOT totalNum: this has to be the figure on the attached document
              // (see the pair's note above). They differ by exactly the sales tax.
              total: emailTotal == null ? "" : emailTotal,
              invoiceUrl: invoicePdfUrl,
              quoteTerms: cur0?.quote_terms,
              // The CTA has to land where they can SIGN. A link straight to the PDF is a
              // dead end for a document that now needs their signature (migration 136).
              signUrl: myQuotesUrl(clientId, req),
            }),
          });
          sent = out.sent;
          if (!out.sent) sendReason = out.reason || "failed";
        } else {
          sendReason = "no email address on this design";
        }
        // THE EMAIL DOES NOT GATE THE INVOICE (Carolyn 2026-08-23, paper-first: most lot
        // customers want a printed invoice, and a design with no email address must still
        // be invoiceable). The invoice is complete the moment it has a number and a
        // document — the sale proceeds either way; the ledger keeps 'created' + the reason
        // when the email didn't land, so "Resend" can finish that half later, and the
        // response says plainly what did and didn't happen.
        await setClaim(sent
          ? { status: "sent", error: null }
          : { status: "created", error: `email not sent: ${sendReason}`.slice(0, 500) });
        // ⚠️ THE STATUS DELIBERATELY DOES NOT MOVE HERE (migration 136). Sending an invoice
        // no longer completes the sale — the CUSTOMER'S SIGNATURE does, and customer-accept's
        // sign_invoice is the only writer of 'invoiced' now. This matters far beyond
        // bookkeeping: SOLD = INVOICED is what gates the build board (portal-schedule
        // create_job), the delivery pool and the Orders schedule column, so flipping it here
        // would put an UNSIGNED building in front of a build crew. ss_invoice_sent_at is the
        // browser-readable "invoice is out, waiting on them" signal the Orders tab renders
        // instead — invoice_sends itself is service-role only and unreadable there.
        await admin.from("designs")
          .update({ ss_invoice_sent_at: nowIso(), updated_at: nowIso() })
          .eq("client_id", clientId).eq("short_code", shortCode);
        // THE INVOICE REQUEST IS ANSWERED (migration 229). A customer's Accept raised a draft
        // (customer-accept), and issuing the invoice is what approving it means — the number,
        // the PDF, the QuickBooks push and the inventory claim around this line. So there is
        // no separate approve action to keep in step with this one. push_to_invoice reaches
        // here too; a rep who invoices before the customer clicks has no row, and this matches
        // nothing. A DISMISSED request is answered as well: "Not now" followed by sending the
        // invoice anyway is an approval, and the row should say so.
        // Written as a separate statement, never folded into the stamp above: until migration
        // 229 is applied the table does not exist, and a failure here must never take
        // ss_invoice_sent_at down with it. Best-effort for the same reason as the stamp — the
        // invoice is recorded and the customer is waiting.
        // …but never SILENT (review, 2026-09-15). A miss leaves the request 'pending' beside an
        // issued invoice, so it is logged where "fix the errors" finds it; and
        // dismiss_invoice_request checks the invoice itself, so the stale row cannot then be set
        // aside on an order whose invoice is already out.
        let approveErr: { message?: string; code?: string } | null = null;
        try {
          const { error } = await admin.from("invoice_requests")
            .update({
              status: "approved",
              decided_at: nowIso(),
              decided_by_user_id: operator ? null : (userId ?? null),
              decided_by_operator: operator ? operator.email : null,
            })
            .eq("client_id", clientId).eq("short_code", shortCode).in("status", ["pending", "dismissed"]);
          approveErr = error;
        } catch (e) {
          approveErr = { message: (e as Error)?.message ?? String(e) };
        }
        if (approveErr) {
          logEdgeError({
            fn: "portal-settings", req, clientId, code: "invoice_request_approve",
            message: `invoice issued but its request was not marked approved: ${approveErr.message ?? "unknown"}`,
            context: { action, shortCode, pgCode: approveErr.code ?? null },
          }).catch(() => {});
        }
        // The invoiced total becomes the order's total when none is set (SS designs are
        // skipped by the GHL total sync, so nothing else ever fills it). NULL-only: a
        // rep-set or CO-acknowledged number is never clobbered.
        if (totalNum != null) {
          await admin.from("orders")
            .update({
              // pretax + tax = total, written together (migration 148): total_cents alone is no
              // longer a safe pre-tax figure and portal-commissions reads it as one.
              ...orderMoneyCols(agreedLines, totalNum),
              total_source: "manual", updated_at: nowIso(),
            })
            .eq("client_id", clientId).eq("short_code", shortCode).is("total_cents", null);
        }
        if (d.inventory_unit_id) {
          await claimUnitSale(d.inventory_unit_id, shortCode, "invoice");
        }
        if (operator) audit("operator_send_invoice_result", null, `short_code=${shortCode} invoice=${invNumber} (structurestudio)`);
        // qboInvoice.ts never reads GHL (verified 2026-08-23): lines come from the same
        // estimate_lines snapshot, the customer from designs.contact. `ghlTotal` is a
        // misnomer here — it only feeds the books' mismatch note.
        //
        // Entitlement-checked like every other QuickBooks door (see QBO_ACTIONS above): a
        // tenant whose subscription lapsed keeps their connection until they revoke it, and
        // this is the path that would otherwise go on writing into their books for free.
        if (await qboPushAllowed()) {
          await pushQboInvoice(admin, clientId, {
            shortCode,
            docNumber: invNumber,
            ghlTotal: totalNum,
          });
        }

        // ── THE INVOICE-TIME TAX CHECK (2026-09-17) — INFORMATIONAL ONLY ─────────────────
        // When the tenant's switch is on, one paid lookup for the delivery address, reported
        // beside the rate the customer agreed to (`taxCheck`). It NEVER changes the invoice: the
        // customer accepted a stated total, the invoice above was built from that agreement, and
        // a different rate is something for the builder to see and decide on, not a number to
        // swap in behind the customer's back. It NEVER blocks either — it runs last, after the
        // invoice is recorded, emailed, pushed to the books and the order filled, so a slow or
        // failed lookup costs nothing but its own answer.
        //
        // ⚠️ OPEN WITH THE PRODUCT OWNER (plan v2, Q1): should the invoice RE-PRICE from a fresh
        // lookup instead of only reporting one? Not confirmed. Until it is, this only reports.
        //
        // One lookup per issued invoice: a re-send or a regenerate of an invoice that already has
        // its number (recoveredNumber) makes no call, so retrying the email never bills again.
        // Same cap, ledger and failure taxonomy as verify_tax (paidLookup). The charge is keyed
        // on this lookup's ledger row and posted only when a rate came back — the `tax_invoice`
        // meter is disarmed, so today it is a no-op.
        //
        // The switch is read on its own, never folded into cur0's select: if migration 244 is
        // not applied yet, an unknown column there would null cur0 and send an SS tenant down the
        // CRM branch. Here it only means the check is skipped.
        let taxCheck: InvoiceTaxCheck = { status: "skipped", reason: "lookup_disabled" };
        {
          const { data: sw, error: swErr } = await admin.from("client_settings")
            .select("tax_lookup_enabled").eq("client_id", clientId).maybeSingle();
          const plan = invoiceTaxCheckPlan({
            lookupEnabled: !swErr && sw?.tax_lookup_enabled === true,
            configured: avalaraConfigured(),
            reissue: !!recoveredNumber,
            agreedTax: (agreedLines as { tax?: unknown } | null)?.tax ?? null,
            address: addressFrom(c?.contact),
          });
          if (!plan.lookup) {
            taxCheck = plan.taxCheck;
          } else {
            const lookup = await paidLookup(admin, {
              clientId, kind: "invoice", shortCode, invoiceNumber: invNumber, address: addressFrom(c?.contact),
              fallbackRate: plan.agreedRate, actorUserId: userId ?? null, operator: !!operator,
            });
            taxCheck = invoiceTaxCheck(plan.agreedRate, lookup);
            if (lookup.lookupId && !lookup.ledgerClosed) {
              logEdgeError({
                fn: "portal-settings", req, clientId, code: "tax_lookup_unclosed",
                message: `send_invoice: the ledger row for invoice ${invNumber} could not be closed`,
                context: { lookupId: lookup.lookupId },
              }).catch(() => {});
            }
            const meter = await chargeLookup(admin, lookup, {
              clientId, kind: "tax_invoice", refType: "invoice", refId: String(invNumber),
              memo: `Sales tax check on invoice ${invNumber}${lookup.ok && lookup.jurisdiction ? ` — ${lookup.jurisdiction}` : ""}`,
              actorUserId: userId ?? null,
            });
            if (!meter.charged && meter.reason === "error") {
              logEdgeError({
                fn: "portal-settings", req, clientId, code: "tax_meter",
                message: `tax_invoice charge failed for ${shortCode} (invoice ${invNumber})`,
                context: { lookupId: lookup.lookupId },
              }).catch(() => {});
            }
          }
        }

        // attested says whether THIS call performed the acceptance, so the designer can tell
        // the rep "invoiced" from "recorded their approval and invoiced". orderId is the
        // navigation target. sent:false is not a failure — the email never gates the invoice.
        return json({ ok: true, invoiceNumber: invNumber, invoicePdfUrl, issuedBy: "structurestudio", sent, attested, quoteNumber: d.ss_quote_number, ...(await loadOrderRef()), ...(sent ? {} : { emailReason: sendReason }), taxCheck });
      }
    }

    // Only ghl_estimate_id is used. `contact` (the customer's name/email/phone/address) and
    // `status` were selected and never read — status is checked against the LIVE GHL
    // estimate further down, not this row. Dropped 2026-08-07: pulling a customer's PII
    // into memory on the invoice path for nothing is the kind of dead read that later
    // becomes an accidental log line.
    const { data: design, error: desErr } = await admin
      .from("designs")
      // inventory_unit_id is the invoice TYPE (new_build vs inventory) and nothing more —
      // deliberately NOT re-adding contact/status here, which the 2026-08-07 trim above
      // removed as a dead PII read on the invoice path.
      .select("short_code, ghl_estimate_id, inventory_unit_id")
      .eq("client_id", clientId).eq("short_code", shortCode).maybeSingle();
    if (desErr) return dbFail(req, clientId, "find that design", desErr);
    if (!design) return json({ error: "Design not found." }, 404);
    if (!design.ghl_estimate_id) return json({ error: "This design has no estimate yet." }, 400);

    const { data: cur, error: curErr } = await admin
      .from("client_settings")
      // email_* + business_* ride along for the own-domain email branch below — the
      // Resend-active check and the branded invoice email's identity fields.
      .select("ghl_location_id, ghl_api_key, email_provider, email_domain_status, business_name, business_phone, business_website, business_logo_url, quote_terms")
      .eq("client_id", clientId).maybeSingle();
    if (curErr) return dbFail(req, clientId, "read your CRM credentials", curErr);
    if (!cur?.ghl_location_id || !cur?.ghl_api_key) {
      return json({ error: "Connect your CRM first (Settings → CRM Connection)." }, 400);
    }
    const locationId = cur.ghl_location_id;
    const ghlHeaders = {
      Authorization: `Bearer ${cur.ghl_api_key}`,
      Version: "2021-07-28",
      "Content-Type": "application/json",
      Accept: "application/json",
    };

    const nowIso = () => new Date().toISOString();
    const setClaim = async (patch: Record<string, unknown>) => {
      const r = await admin.from("invoice_sends").update({ ...patch, updated_at: nowIso() })
        .eq("client_id", clientId).eq("short_code", shortCode);
      // See the twin above: mirror the invoicer onto the design for the Pipeline board.
      if (Object.prototype.hasOwnProperty.call(patch, "sender_user_id")) {
        const who = operator ? null : (patch.sender_user_id ?? null);
        await admin.from("designs").update({ invoiced_by_user_id: who })
          .eq("client_id", clientId).eq("short_code", shortCode)
          .then(() => undefined, () => undefined);
      }
      return r;
    };
    // Every GHL call is wrapped: an unhandled fetch rejection would otherwise surface as
    // an opaque 500 with no CORS headers, losing the "invoice was created" warning.
    const ghl = async (url: string, init?: RequestInit) => {
      try {
        const r = await fetch(url, init);
        const body = await r.json().catch(() => null);
        return { ok: r.ok, status: r.status, body };
      } catch (e) {
        return { ok: false, status: 0, body: null, netErr: (e as Error)?.message || "network error" };
      }
    };
    const STALE_CLAIM_MS = 3 * 60 * 1000;

    // ── Own-domain email branch (Resend-active tenants) ────────────────────────
    // When the tenant has flipped the provider AND verified their domain AND the hosted
    // invoice link is buildable AND we know the customer's address, the GHL send call
    // flips to action:"send_manually" — GHL marks the invoice sent (hosted page live,
    // status derivations intact) WITHOUT emailing anyone (verified live 2026-08-10; the
    // send body REQUIRES userId even for send_manually, and a second send call on the
    // same invoice is idempotent) — and the branded email goes out from the tenant's own
    // domain via sendTenantEmail. Returns true ONLY when the customer actually got that
    // email; every other outcome returns false and the caller falls through to today's
    // action:"email" GHL send unchanged, so an email problem can never strand a sent
    // invoice. email_sends rows are additional telemetry — the invoice_sends claim
    // machinery above stays untouched and authoritative for convert-idempotency.
    const rsActive = resendConfigured() &&
      cur.email_provider === "resend" && cur.email_domain_status === "verified";
    const tryOwnDomainEmail = async (
      invId: string,
      invNumber: string | null,
      senderUserId: string,
      knownTotal: number | null,
    ): Promise<boolean> => {
      if (!rsActive) return false;
      const hosted = invoiceUrl(invId);
      if (!hosted) return false;
      // The customer's address, read ONLY here: the design select above deliberately
      // dropped `contact` as a dead PII read (2026-08-07), and it stays dead unless this
      // path is actually addressing an email.
      const { data: c } = await admin.from("designs").select("contact")
        .eq("client_id", clientId).eq("short_code", shortCode).maybeSingle();
      const to = String((c?.contact as { email?: unknown } | null)?.email ?? "").trim();
      if (!isEmail(to)) return false;
      // Recovery path has no convert response to read the total off — best-effort GET of
      // the live invoice, so the branded email's "Amount due" isn't blank. A miss leaves
      // the amount out; it never blocks the send.
      let total = knownTotal;
      if (total == null) {
        const inv = await ghl(`https://services.leadconnectorhq.com/invoices/${encodeURIComponent(invId)}?altId=${encodeURIComponent(locationId)}&altType=location`, { headers: ghlHeaders });
        const t = Number(inv.body?.invoice?.total ?? inv.body?.total);
        if (inv.ok && Number.isFinite(t)) total = t;
      }
      const manual = await ghl(`https://services.leadconnectorhq.com/invoices/${encodeURIComponent(invId)}/send`, {
        method: "POST", headers: ghlHeaders,
        body: JSON.stringify({ altId: locationId, altType: "location", action: "send_manually", liveMode: true, userId: senderUserId }),
      });
      if (!manual.ok) return false;
      const out = await sendTenantEmail(admin, clientId, {
        kind: "invoice",
        shortCode,
        to,
        ...invoiceEmail({
          businessName: String(cur.business_name ?? "").trim() || clientId,
          logoUrl: cur.business_logo_url,
          phone: cur.business_phone,
          website: cur.business_website,
          invoiceNumber: invNumber ?? "",
          total: total ?? "",
          invoiceUrl: hosted,
          quoteTerms: cur.quote_terms,
        }),
      });
      return out.sent;
    };

    // ── 1. Claim the send (idempotency + recovery). ──────────────────────────────
    let resendInvoiceId: string | null = null;   // set when recovering a created-but-unsent invoice
    let resendInvoiceNumber: string | null = null;
    let resendSenderUserId: string | null = null;
    // The claim key is (client_id, short_code) where client_id is the TENANT — never the
    // actor. Do NOT add the operator to this key: an operator send and an owner send would
    // then each take their own claim on the same design and both could convert the same
    // estimate. Attribution belongs in sent_by_operator, which is not part of the PK.
    const claimIns = await admin.from("invoice_sends").insert({
      client_id: clientId, short_code: shortCode,
      ghl_estimate_id: String(design.ghl_estimate_id), status: "claimed", attempts: 1,
      sent_by_operator: operator ? operator.email : null,
      // Carolyn 2026-08-07: "EVERY INVOICE needs a TYPE." Stamped at the claim, which is the
      // moment the invoice is raised — a SNAPSHOT, not a lookup. Untying this design from its
      // unit later must not retroactively change the type of an invoice that has already gone
      // to a customer and into their books. An `inventory` invoice is also what tells the
      // schedule to skip the build board: the building already exists, so the buyer's order
      // must never spawn a second, new-build job.
      invoice_type: invoiceTypeFor(design),
    });
    if (claimIns.error) {
      // 23505 = the row exists → inspect it instead of converting again.
      const { data: prior } = await admin.from("invoice_sends")
        .select("status, invoice_id, invoice_number, updated_at, attempts, sender_user_id, ghl_sender_user_id")
        .eq("client_id", clientId).eq("short_code", shortCode).maybeSingle();
      if (!prior) return dbFail(req, clientId, "start the invoice send", claimIns.error);
      const st = String(prior.status || "");
      if (st === "sent") {
        return json({ error: `Invoice ${prior.invoice_number ?? ""} was already sent for this design.` }, 400);
      }
      if (st === "created") {
        // The invoice EXISTS in GHL but was never emailed → re-send it, do not convert.
        resendInvoiceId = prior.invoice_id ? String(prior.invoice_id) : null;
        resendInvoiceNumber = prior.invoice_number ? String(prior.invoice_number) : null;
        // `ghl_sender_user_id`, NOT `sender_user_id` (migration 215). Those are two different
        // ids and they were one column until today: this one is GoHighLevel's own user id, an
        // API argument naming which GHL user the email appears to come from; the other is the
        // portal user who pressed send, which is what commissions pay.
        //
        // Reading the right one is what keeps a RESEND going out as the same GHL user the
        // invoice was raised as. Falling back to `users[0]` would re-send junior-barns'
        // invoices as whoever happens to be first in his sub-account — and he is the only
        // builder whose invoices are real money, and sells exclusively through GHL.
        resendSenderUserId = prior.ghl_sender_user_id ? String(prior.ghl_sender_user_id) : null;
        if (!resendInvoiceId) return json({ error: "An invoice was created in your CRM for this design but its id wasn't recorded — send it from your CRM." }, 409);
      } else if (st === "claimed") {
        const age = Date.now() - new Date(String(prior.updated_at)).getTime();
        if (age < STALE_CLAIM_MS) {
          return json({ error: "An invoice for this design is already being sent — give it a moment." }, 409);
        }
      }
      await setClaim({ status: "claimed", error: null, attempts: (Number(prior.attempts) || 1) + 1 });
    }

    let invoiceId = resendInvoiceId;
    let invoiceNumber: string | null = resendInvoiceNumber;
    let ghlInvoiceTotal: number | null = null; // for the QBO push's mismatch note only

    if (!invoiceId) {
      // ── 2. Read the live estimate: must be accepted (and not already invoiced). ──
      let est: any = null;
      const limit = 100;
      for (let offset = 0; offset < 2000 && !est; offset += limit) {
        const r = await ghl(`https://services.leadconnectorhq.com/invoices/estimate/list?altId=${encodeURIComponent(locationId)}&altType=location&limit=${limit}&offset=${offset}`, { headers: ghlHeaders });
        if (!r.ok) {
          await setClaim({ status: "failed", error: `estimate list ${r.status}` });
          return json({ error: `Could not read estimates from your CRM (${r.status || r.netErr}).` }, 502);
        }
        const arr: any[] = Array.isArray(r.body?.estimates) ? r.body.estimates : [];
        est = arr.find((e) => String(e?._id ?? "") === String(design.ghl_estimate_id)) ?? null;
        if (arr.length < limit) break;
      }
      if (!est) {
        await setClaim({ status: "failed", error: "estimate not found" });
        return json({ error: "The estimate could not be found in your CRM." }, 404);
      }
      const estStatus = String(est?.estimateStatus ?? "").toLowerCase();
      if (estStatus === "invoiced") {
        await setClaim({ status: "failed", error: "already invoiced in GHL" });
        return json({ error: "This estimate was already invoiced in your CRM — send that invoice from there." }, 400);
      }
      if (estStatus !== "accepted") {
        await setClaim({ status: "failed", error: `estimate status ${estStatus || "sent"}` });
        return json({ error: `The customer hasn't accepted this estimate yet (status: ${estStatus || "sent"}).` }, 400);
      }

      // ── 3. Resolve the GHL sender BEFORE converting (GHL: "either userId or sentFrom"). ──
      //
      // ⚠️ RENAMED FROM `userId` ON 2026-09-07, AND THE OLD NAME WAS THE BUG. A local `userId`
      // here SHADOWED the caller's own `userId` from r.ctx (destructured at the top of this
      // file), so `sender_user_id: userId` a few lines down stored a GOHIGHLEVEL user id in a
      // column that portal-commissions reads as the commission earner. Two different kinds of
      // id in one column, and the wrong one winning on every GHL-issued invoice.
      //
      // What it cost, measured 2026-09-07: 10 of 10 GHL invoices carried a GHL id, none of
      // which matches a portal user, so portal-commissions:858 (`!teamSet.has(earner)`)
      // discarded every one. Live state at the time: 21 commission_entries, 3 with an earner,
      // ZERO with an amount. Nobody had been credited for a sale since invoicing began.
      //
      // This value is still a GHL id and MUST stay one — it is an argument to GHL's own API,
      // naming which of their users the email appears to come from. It is not a person in this
      // product. Never store it as an actor.
      let ghlSenderId = String(est?.sentBy ?? "");
      if (!ghlSenderId) {
        const ur = await ghl(`https://services.leadconnectorhq.com/users/?locationId=${encodeURIComponent(locationId)}`, { headers: ghlHeaders });
        const users: any[] = Array.isArray(ur.body?.users) ? ur.body.users : [];
        ghlSenderId = String(users[0]?.id ?? "");
      }
      if (!ghlSenderId) {
        // Fail fast: converting first would leave an un-sendable invoice behind.
        await setClaim({ status: "failed", error: "no GHL user to send as" });
        return json({ error: "Your CRM has no user to send the invoice as — add a user to that sub-account, then try again. (Nothing was invoiced.)" }, 400);
      }

      // ── 4. Convert estimate → invoice (IRREVERSIBLE: marks the estimate invoiced). ──
      const convRes = await ghl(`https://services.leadconnectorhq.com/invoices/estimate/${encodeURIComponent(String(design.ghl_estimate_id))}/invoice`, {
        method: "POST", headers: ghlHeaders,
        body: JSON.stringify({ altId: locationId, altType: "location", markAsInvoiced: true }),
      });
      if (!convRes.ok) {
        await setClaim({ status: "failed", error: `convert ${convRes.status}` });
        return json({ error: `Creating the invoice failed: ${convRes.body?.message ?? convRes.status ?? convRes.netErr}` }, 502);
      }
      const invoice = convRes.body?.invoice ?? convRes.body ?? {};
      invoiceId = String(invoice?._id ?? invoice?.id ?? "");
      invoiceNumber = invoice?.invoiceNumber != null ? String(invoice.invoiceNumber) : null;
      ghlInvoiceTotal = Number.isFinite(Number(invoice?.total)) ? Number(invoice.total) : null;
      if (!invoiceId) {
        await setClaim({ status: "failed", error: "no invoice id returned" });
        return json({ error: "Your CRM did not return an invoice id." }, 502);
      }
      // Record it IMMEDIATELY: from here on the invoice exists in GHL, so even if the
      // email fails (or this function dies) the retry re-sends instead of converting.
      // BOTH ids, each in its own column (migration 215):
      //   sender_user_id      — `userId` is the OUTER one again, the portal user who pressed
      //                         send. The actor. What commissions pay.
      //   ghl_sender_user_id  — the GHL user the invoice was raised as, so a later resend
      //                         goes out as the same person rather than whoever GHL lists
      //                         first.
      await setClaim({
        status: "created", invoice_id: invoiceId, invoice_number: invoiceNumber, error: null,
        sender_user_id: userId ?? null,
        ghl_sender_user_id: ghlSenderId || null,
      });

      // ── 5. Email it to the customer — own-domain branch first, GHL's email otherwise.
      //    tryOwnDomainEmail returning false (whatever the reason) lands on the stock GHL
      //    send below unchanged; if send_manually already ran, that second send call is
      //    idempotent (verified live 2026-08-10). ──
      const ownDomainSent = await tryOwnDomainEmail(invoiceId, invoiceNumber, ghlSenderId, ghlInvoiceTotal);
      if (!ownDomainSent) {
        const sendRes = await ghl(`https://services.leadconnectorhq.com/invoices/${encodeURIComponent(invoiceId)}/send`, {
          method: "POST", headers: ghlHeaders,
          body: JSON.stringify({ altId: locationId, altType: "location", action: "email", liveMode: true, userId: ghlSenderId }),
        });
        if (!sendRes.ok) {
          await setClaim({ status: "created", error: `send ${sendRes.status || sendRes.netErr}: ${sendRes.body?.message ?? ""}`.slice(0, 500) });
          return json({
            error: `Invoice ${invoiceNumber ?? ""} was created in your CRM but the email didn't go out (${sendRes.body?.message ?? sendRes.status ?? sendRes.netErr}). Click Send invoice on this design again to retry the email — it will NOT create a second invoice.`,
            invoiceId, invoiceNumber, created: true, sent: false,
          }, 502);
        }
      }
    } else {
      // ── Recovery path: the invoice already exists, only the email is outstanding.
      //    Reuse the sender recorded on the first attempt when we have it. ──
      // Same rename, same reason as the block above: a GHL API parameter, not an actor.
      let ghlSenderId = resendSenderUserId || "";
      if (!ghlSenderId) {
        const ur = await ghl(`https://services.leadconnectorhq.com/users/?locationId=${encodeURIComponent(locationId)}`, { headers: ghlHeaders });
        const users: any[] = Array.isArray(ur.body?.users) ? ur.body.users : [];
        ghlSenderId = String(users[0]?.id ?? "");
      }
      if (!ghlSenderId) {
        return json({ error: "Your CRM has no user to send the invoice as — add a user to that sub-account, then retry." }, 400);
      }
      // Own-domain branch first here too — the recovery is only ever about the EMAIL
      //  (the invoice already exists), so the same rule applies: our branded send when the
      //  tenant is Resend-active, the stock GHL email as the unchanged fallback.
      const ownDomainSent = await tryOwnDomainEmail(invoiceId, invoiceNumber, ghlSenderId, null);
      if (!ownDomainSent) {
        const sendRes = await ghl(`https://services.leadconnectorhq.com/invoices/${encodeURIComponent(invoiceId)}/send`, {
          method: "POST", headers: ghlHeaders,
          body: JSON.stringify({ altId: locationId, altType: "location", action: "email", liveMode: true, userId: ghlSenderId }),
        });
        if (!sendRes.ok) {
          await setClaim({ status: "created", error: `resend ${sendRes.status || sendRes.netErr}`.slice(0, 500) });
          return json({ error: `Retrying the email for invoice ${invoiceNumber ?? ""} failed (${sendRes.body?.message ?? sendRes.status ?? sendRes.netErr}). You can send it from your CRM.`, invoiceId, invoiceNumber, created: true, sent: false }, 502);
        }
      }
    }

    // ── 6. Done: mark the ledger sent and cache the design's status. ──
    await setClaim({ status: "sent", error: null });
    await admin.from("designs")
      .update({ status: "invoiced", updated_at: nowIso() })
      .eq("client_id", clientId).eq("short_code", shortCode);

    // ── 6b. If this estimate was quoted from a lot building, that building is now SOLD. ──
    // THIS is what makes "invoice it and the row reads SOLD — Dave" true, and true AT THIS
    // MOMENT. Before this, the sale was only noticed by sync-design-status on somebody's next
    // page load — and it fired at `accepted`, a rung too early, so a building went off the
    // market on a handshake rather than an invoice.
    if (design.inventory_unit_id) {
      await claimUnitSale(design.inventory_unit_id, shortCode, "invoice");
    }
    // Result row closes the attempt row written before the convert. Best-effort here —
    // the money has already moved, so failing the response now would only mislead.
    if (operator) audit("operator_send_invoice_result", null, `short_code=${shortCode} invoice=${invoiceNumber ?? invoiceId}`);

    // ── 7. QuickBooks push — bookkeeping, strictly after the money moved. ──
    // pushQboInvoice never throws and never touches this response; every outcome lands
    // on the invoice_sends row (qbo_* columns). Dark unless the tenant is connected AND
    // the design has an estimate_lines snapshot, so this is a no-op for everyone today.
    // Entitlement-checked, the same as the SS branch's push — see QBO_ACTIONS above.
    if (await qboPushAllowed()) {
      await pushQboInvoice(admin, clientId, {
        shortCode,
        docNumber: invoiceNumber,
        ghlTotal: ghlInvoiceTotal,
      });
    }

    return json({ ok: true, invoiceId, invoiceNumber, sent: true });
  }

  if (action === "retry_qbo_push") {
    // Re-run the QuickBooks push for an invoice that was sent but never landed in the
    // books (typically: mappings were incomplete at send time and the push aborted).
    // Owner/admin by omission from READ_ACTIONS.
    const shortCode = String(payload?.shortCode ?? "").trim();
    if (!shortCode) return json({ error: "shortCode is required." }, 400);

    const { data: row } = await admin.from("invoice_sends")
      .select("status, invoice_number, qbo_invoice_id")
      .eq("client_id", clientId).eq("short_code", shortCode).maybeSingle();
    if (!row) return json({ error: "No invoice has been sent for this design." }, 404);
    if (row.status !== "sent") return json({ error: "The invoice email hasn't gone out yet — retry that first." }, 400);
    if (row.qbo_invoice_id) return json({ ok: true, alreadyPushed: true, qboInvoiceId: row.qbo_invoice_id, clientId });

    await pushQboInvoice(admin, clientId, { shortCode, docNumber: row.invoice_number ?? null });

    const { data: after } = await admin.from("invoice_sends")
      .select("qbo_invoice_id, qbo_doc_number, qbo_error")
      .eq("client_id", clientId).eq("short_code", shortCode).maybeSingle();
    await audit("qbo_retry_push", 1, after?.qbo_invoice_id ? `pushed ${after.qbo_doc_number ?? ""}` : (after?.qbo_error ?? null));
    return json({
      ok: !!after?.qbo_invoice_id,
      qboInvoiceId: after?.qbo_invoice_id ?? null,
      qboDocNumber: after?.qbo_doc_number ?? null,
      error: after?.qbo_invoice_id ? null : (after?.qbo_error ?? "The push did not complete."),
      clientId,
    });
  }

  return json({ error: `Unknown action "${action}".` }, 400);
}, { alreadyFiled: (res) => filedAtReturnSite.has(res) }));
