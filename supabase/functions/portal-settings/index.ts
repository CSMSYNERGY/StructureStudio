import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";
import { resolveTenant } from "../_shared/resolveTenant.ts";
import { withErrorLog, logEdgeError } from "../_shared/logError.ts";
import { getQboConnection, qboFetch, qboOauthReady, QboApiError, QboBroken, QboNotConnected } from "../_shared/qboToken.ts";
import { qboEndpoints } from "../_shared/qboDiscovery.ts";
import { pushQboInvoice } from "../_shared/qboInvoice.ts";
import { deriveLifecycle, LIFECYCLE_LABEL, type StageKind } from "../_shared/inventoryLifecycle.ts";
import { invoiceTypeFor } from "../_shared/invoiceType.ts";
import {
  rsCreateDomain, rsDeleteDomain, rsGetDomain, rsVerifyDomain, rsDomainVerified,
  resendConfigured, ResendApiError, ResendNotConfigured, type RsDomain,
} from "../_shared/resend.ts";
import { sendTenantEmail } from "../_shared/emailSend.ts";
import { estimateEmail, invoiceEmail, testEmail } from "../_shared/emailTemplates.ts";
import { invoiceUrl } from "../_shared/ghlLinks.ts";
import { myQuotesUrl } from "../_shared/customerPortalUrl.ts";
import { totalFromSnapshot } from "../_shared/estimateLines.ts";
import { sanitizeD3Spec, sanitizePhotoUrls, parseModelSpec, parseObservedNotes, SPEC_PROMPT, VIDEO_SHAPE_PROMPT } from "../_shared/styleD3.ts";

import type { GateTable } from "../_shared/access.ts";

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
  create_style:              { area: "settings_structures", level: "edit" },
  update_style:              { area: "settings_structures", level: "edit" },
  delete_style:              { area: "settings_structures", level: "edit" },
  reorder_styles:            { area: "settings_structures", level: "edit" },
  set_style_active:          { area: "settings_structures", level: "edit" },
  set_style_estimate_image:  { area: "settings_structures", level: "edit" },

  // ── Per-style 3D appearance (the `d3` spec, photos and phone-scan model) ──
  // Grafted from beta-2.0 in the 3D merge. These write `building_styles.d3` /
  // `.d3_photos` / `model_*`, which `get_config` emits to every ANON browser, so they are
  // structure edits and gate exactly like every other style writer above. They arrived
  // with no GATES lines at all: the dispatcher fails closed, so they would have 403'd on
  // a real builder rather than shipping open -- and preflight's cross-check is what named
  // them here instead of letting that surface as "the 3D calibration button is broken".
  save_style_d3:             { area: "settings_structures", level: "edit" },
  calibrate_style_ai:        { area: "settings_structures", level: "edit" },
  upload_style_photo:        { area: "settings_structures", level: "edit" },
  save_style_model:          { area: "settings_structures", level: "edit" },
  set_style_model_status:    { area: "settings_structures", level: "edit" },
  style_model_url:           { area: "settings_structures", level: "edit" },

  // ── Options & colours ────────────────────────────────────────────────────
  save_colors:                    { area: "settings_options", level: "edit" },
  save_window_colors:             { area: "settings_options", level: "edit" },
  save_layout_pricing:            { area: "settings_options", level: "edit" },
  upload_layout_image:            { area: "settings_options", level: "edit" },
  upload_fixture_image:           { area: "settings_options", level: "edit" },
  save_fixture:                   { area: "settings_options", level: "edit" },
  delete_fixture:                 { area: "settings_options", level: "edit" },
  reorder_fixtures:               { area: "settings_options", level: "edit" },
  import_fixtures:                { area: "settings_options", level: "edit" },
  set_layout_item_archived:       { area: "settings_options", level: "edit" },
  set_layout_item_internal_only:  { area: "settings_options", level: "edit" },
  save_ramp_settings:             { area: "settings_options", level: "edit" },
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

  // ── QuickBooks ───────────────────────────────────────────────────────────
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
  email_verify_domain:  { area: "settings_email", level: "edit" },
  email_activate:       { area: "settings_email", level: "edit" },
  email_send_test:      { area: "settings_email", level: "edit" },
  email_disconnect:     { area: "settings_email", level: "edit" },

  // ── Workspace ────────────────────────────────────────────────────────────
  contact_activity: { area: "contacts", level: "view" },
  delete_design:    { area: "designs", level: "edit" },
  // NOT inventory:edit. A sales rep's preset is inventory:'view', and this only tags a
  // design they just created with the unit it was quoted from — gating it on inventory:edit
  // recreates the 2026-08-02 bug exactly (estimate sent, link 403s, the building never
  // shows the estimate and never flips to Sold).
  link_design_to_unit: { area: "designs", level: "edit" },
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
  // Re-sends the SS quote email (migration 122) — the rep who can edit designs can re-send
  // the quote for one. Idempotent (no numbering, no conversion): worst case is a duplicate
  // email to the design's own customer.
  resend_quote_email: { area: "designs", level: "edit" },
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
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

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

  if (action === "status") {
    const { data, error } = await admin
      .from("client_settings")
      .select("ghl_location_id, ghl_api_key, ghl_pipeline_id, ghl_stage_send_quote_id, ghl_stage_accepted_id, ghl_stage_invoiced_id, ghl_stage_delivered_id, business_name, business_phone, business_website, business_address, business_logo_url, quote_terms, beta_mode, beta_email, show_pricing, invoice_in_ghl, ss_quote_next, ss_quote_prefix, updated_at")
      .eq("client_id", clientId)
      .maybeSingle();
    if (error) return dbFail(req, clientId, "load your settings", error);
    // Designer branding lives in client_configs (drives the public ?client= link).
    const { data: cfg } = await admin
      .from("client_configs")
      .select("company_name, tagline, logo_url, accent_color, header_bg")
      .eq("client_id", clientId)
      .maybeSingle();
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
        ssQuoteNext: data?.ss_quote_next ?? null,
        ssQuotePrefix: data?.ss_quote_prefix ?? "",
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
      },
    });
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

    // Turning CRM invoicing OFF hands the numbering to us, so a start value has to exist
    // before the switch flips — otherwise the first SS quote would begin at 1 and collide
    // with the tenant's existing paperwork. Checked against the MERGED state (the two
    // controls can arrive in separate saves), the same way the beta pair below is.
    if ("invoiceInGhl" in payload || "ssQuoteNext" in payload) {
      const { data: curInv } = await admin
        .from("client_settings").select("invoice_in_ghl, ss_quote_next").eq("client_id", clientId).maybeSingle();
      const nextInGhl = "invoiceInGhl" in payload ? Boolean(payload.invoiceInGhl) : curInv?.invoice_in_ghl !== false;
      const nextStart = "ssQuoteNext" in payload ? updates.ss_quote_next : (curInv?.ss_quote_next ?? null);
      if (!nextInGhl && nextStart == null) {
        return json({
          error: "StructureStudio needs a starting quote number before it can issue your quotes — set one so your numbering continues where your CRM left off.",
        }, 400);
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
    const [styles, sizes, items, types, incl, lpRows, colorsRes, fixturesRes, csRamp, windowColorsRes] = await Promise.all([
      // d3 / d3_photos (086): the per-style 3D spec, so the Structures tab can show which
      // styles are calibrated and the editor can reopen one for tuning.
      admin.from("building_styles").select("id, key, label, image_url, active, show_image_on_estimate, d3, d3_photos, model_url, model_status, model_uploaded_at, model_locked_at, model_meta").eq("client_id", clientId).order("sort_order"),
      admin.from("building_sizes").select("id, style_id, label, width_ft, length_ft, base_price, active").eq("client_id", clientId).order("sort_order"),
      admin.from("client_layout_items").select("item_key, label_override, active, archived, internal_only, sort_order").eq("client_id", clientId).order("sort_order"),
      admin.from("layout_item_types").select("item_key, label"),
      admin.from("building_size_inclusions").select("size_id, item_key, included, qty").eq("client_id", clientId),
      // Default (style_id IS NULL) layout-item prices for the Layout Pricing tab.
      admin.from("layout_item_pricing").select("item_key, pricing_method, rate, image_url").eq("client_id", clientId).is("style_id", null),
      // Color palette for the Colors tab (paint = siding/trim; roof = shingle/metal).
      admin.from("colors").select("id, label, siding, trim, shingle, metal, door, door_rate, allow_custom, is_default, rate, pricing_method, hex, image_url, sort_order, active").eq("client_id", clientId).order("sort_order"),
      // Fixtures catalog (Options tab → Doors section; windows/ramps later via `category`).
      admin.from("fixture_items").select("id, category, name, plan_label, width_in, height_in, price, swing_in, swing_out, swing_default, op_right, op_left, op_double, op_slideup, op_default, color_mode, has_trim_color, fixed_color_id, window_color_ids, image_url, show_image_on_estimate, sort_order, active, archived, internal_only").eq("client_id", clientId).order("sort_order"),
      // Ramp mode + simple-ramp config (client_settings, service-role only).
      admin.from("client_settings").select("ramp_mode, ramp_price, ramp_price_method, ramp_image_url, ramp_show_image, ramp_enabled").eq("client_id", clientId).maybeSingle(),
      // Window colors (116): the small per-client list every window fixture offers.
      admin.from("window_colors").select("id, label, hex, rate, is_default, sort_order, active").eq("client_id", clientId).order("sort_order"),
    ]);
    // csRamp is in this list. It used to be the one query of the nine whose error was not
    // checked, and its defaults are not neutral: `rs` would come back undefined and the
    // block below would fall through to `mode: "simple", enabled: true` — i.e. a tenant who
    // had deliberately turned ramps OFF would be shown, and would sell, as offering one.
    // Failing the request is right for a settings read; a half-true catalog is not.
    for (const r of [styles, sizes, items, types, incl, lpRows, colorsRes, fixturesRes, csRamp, windowColorsRes]) if (r.error) return dbFail(req, clientId, "load your catalog", r.error);
    const labelByKey: Record<string, string> = {};
    (types.data ?? []).forEach((t: any) => { labelByKey[t.item_key] = t.label; });
    const itemList = (items.data ?? []).filter((i: any) => i.active || i.archived)
      .map((i: any) => ({ key: i.item_key, label: i.label_override || labelByKey[i.item_key] || i.item_key, archived: !!i.archived, internalOnly: !!i.internal_only }));
    const rs = csRamp.data;
    const rampSettings = { mode: (rs?.ramp_mode || "simple"), price: rs?.ramp_price ?? null, method: (rs?.ramp_price_method || "each"), imageUrl: rs?.ramp_image_url ?? null, showImage: rs?.ramp_show_image !== false, enabled: rs?.ramp_enabled !== false };
    // aiReady lets the editor DISABLE "Draft from photos" with a reason rather than letting a
    // builder click a button that can only fail: the Anthropic key is an edge secret, so the
    // browser has no other way to know whether the feature is configured.
    return json({ ok: true, clientId, styles: styles.data, sizes: sizes.data, items: itemList, inclusions: incl.data, layoutPricing: lpRows.data ?? [], colors: colorsRes.data ?? [], fixtures: fixturesRes.data ?? [], windowColors: windowColorsRes.data ?? [], rampSettings, aiReady: Boolean(Deno.env.get("ANTHROPIC_API_KEY")) });
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
      logEdgeError({
        fn: "portal-settings", req, clientId, code: prodStatus,
        message: `verify_save_ghl: GoHighLevel rejected the products probe (HTTP ${prodStatus})`,
        context: { action: "verify_save_ghl", body: prodBody.slice(0, 600) },
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
      logEdgeError({
        fn: "portal-settings", req, clientId, code: r.status,
        message: `list_ghl_pipelines: GoHighLevel rejected the pipelines fetch (HTTP ${r.status})`,
        context: { action: "list_ghl_pipelines", body },
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
  if (action === "delete_design") {
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
    //    altType scope it to the sub-account, the same pair every other estimate call in this
    //    file already sends. Two rules here, both deliberate:
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
                },
              },
            );
            // 404 is the desired end state reached by another route (already deleted in the
            // CRM, or a half-finished earlier attempt), so it counts as done rather than as an
            // error the operator has to interpret. That is also what makes a retry safe.
            estimate = (r.ok || r.status === 404) ? "deleted" : "failed";
            if (estimate === "failed") estimateError = `CRM returned ${r.status}`;
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
  const findStyleFor3D = async (styleValue: string, styleId: string) => {
    let q = admin.from("building_styles").select("id, key, model_status, model_url").eq("client_id", clientId);
    q = styleId ? q.eq("id", styleId) : q.eq("key", styleValue);
    const { data, error } = await q.maybeSingle();
    if (error) return { err: json({ error: error.message }, 500) };
    if (!data) return { err: json({ error: "Style not found (or not yours)." }, 404) };
    return { style: data as { id: string; key: string; model_status: string; model_url: string | null } };
  };
  // The lock freezes SETUP only. Prices, sizes, active/hidden and the estimate-image flag stay
  // editable on a locked style on purpose: those are commercial decisions a builder makes every
  // week, while the geometry is the thing that must stop moving once it matches a real building
  // customers are being quoted against.
  const LOCKED_MSG = "This style's 3D setup is locked. Unlock it first if you really need to change the shape.";

  if (action === "save_style_d3") {
    const styleValue = String(payload.styleValue ?? "").trim();
    const styleId = String(payload.styleId ?? "").trim();
    if (!styleValue && !styleId) return json({ error: "styleValue (or styleId) is required." }, 400);
    const clean = sanitizeD3Spec(payload.d3);
    if (!clean.ok) return json({ error: clean.error }, 400);
    const photos = sanitizePhotoUrls(payload.d3Photos);
    const found = await findStyleFor3D(styleValue, styleId);
    if (found.err) return found.err;
    if (found.style!.model_status === "locked") return json({ error: LOCKED_MSG }, 409);
    const { error, count } = await admin.from("building_styles")
      .update({ d3: clean.d3, d3_photos: photos, updated_at: new Date().toISOString() }, { count: "exact" })
      .eq("client_id", clientId).eq("id", found.style!.id);
    if (error) return json({ error: error.message }, 500);
    if (!count) return json({ error: "Style not found (or not yours)." }, 404);
    return json({ ok: true, d3: clean.d3, d3Photos: photos });
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

  // Draft a 3D spec from reference photos with Claude. The builder reviews and tunes the
  // result before anything is saved — this only ever returns a draft.
  //
  // Capped per tenant per day because it spends real money per call and is now reachable
  // by any owner/admin rather than by whoever holds the operator password. The ledger row
  // is written BEFORE the model call on purpose: a failing style would otherwise be a free
  // retry loop against our API key.
  if (action === "calibrate_style_ai") {
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
    const fromVideo = payload.source === "video";
    const photoUrls = sanitizePhotoUrls(payload.photoUrls, fromVideo ? 8 : 4);
    if (photoUrls.length === 0) return json({ error: "At least one photo URL is required." }, 400);
    const apiKey = Deno.env.get("ANTHROPIC_API_KEY");
    if (!apiKey) return json({ error: "AI drafting isn't configured yet (ANTHROPIC_API_KEY is unset)." }, 500);

    const DAILY_CAP = 10;
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
    } else if ((used ?? 0) >= DAILY_CAP) {
      return json({ error: `Daily limit reached (${DAILY_CAP} AI drafts). Tune the sliders by hand, or try again tomorrow.` }, 429);
    }
    // CHECKED on purpose: this row IS the spend cap. Unchecked, a failed insert (table
    // drift, RLS change) still let the model call proceed -- unmetered spend on exactly the
    // path the ledger exists to meter (audit 2026-08-19). Refusing is the safe side; the
    // cap query above already failed soft for the read case.
    const { error: ledgerErr } = await admin.from("ai_style_calls").insert({ client_id: clientId, user_id: userId ?? null, style_key: String(payload.styleValue ?? "").slice(0, 120) || null });
    if (ledgerErr) return json({ error: "The AI drafting meter is unavailable right now - try again shortly." }, 503);

    let res: Response;
    try {
      res = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: { "content-type": "application/json", "x-api-key": apiKey, "anthropic-version": "2023-06-01" },
        body: JSON.stringify({
          model: "claude-sonnet-5",
          // The video prompt asks for an `observed` block on top of the spec, so it needs
          // the headroom. A truncated reply is unparseable, not partially useful.
          max_tokens: fromVideo ? 900 : 700,
          messages: [{
            role: "user",
            content: [
              // URL sources: the photos live in public buckets, so Anthropic can fetch them
              // and we never proxy the bytes through this function.
              ...photoUrls.map((url) => ({ type: "image", source: { type: "url", url } })),
              { type: "text", text: fromVideo ? VIDEO_SHAPE_PROMPT : SPEC_PROMPT },
            ],
          }],
        }),
      });
    } catch (e) {
      return json({ error: `Could not reach the AI service: ${e instanceof Error ? e.message : String(e)}` }, 502);
    }
    if (!res.ok) {
      const body = (await res.text()).slice(0, 300);
      return json({ error: `AI service returned ${res.status}: ${body}` }, 502);
    }
    const data = await res.json().catch(() => null) as any;
    const text = data?.content?.[0]?.text ?? "";
    const drafted = parseModelSpec(text);
    if (!drafted.ok) return json({ error: drafted.error }, 502);
    // `frames` makes a silent truncation visible; `observed` is the builder-facing note
    // about doors, windows and vents, which the spec has no field for.
    return json({ ok: true, d3: drafted.d3, frames: photoUrls.length, observed: fromVideo ? parseObservedNotes(text) : null });
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
      if (res.error) { skipped.push(`${label}: ${res.error.message}`); i++; continue; }
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
  const FIXTURE_CATEGORIES = new Set(["door", "window", "ramp"]);
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
    if (!("swing_in" in rec)) {
      rec.swing_in = false; rec.swing_out = false; rec.swing_default = null;
      rec.op_right = false; rec.op_left = false; rec.op_double = false; rec.op_slideup = false; rec.op_default = null;
    }
    if (!("color_mode" in rec)) { rec.color_mode = "fixed"; rec.has_trim_color = false; rec.fixed_color_id = null; }
    if (!("window_color_ids" in rec)) rec.window_color_ids = null;
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
    const locations = (locs.data ?? []).map((l: any) => ({ ...l, buildings: counts[l.id] || 0 }));
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
    // so they show "no location" rather than blocking the delete or vanishing.
    const { error, count } = await admin.from("builder_locations").delete({ count: "exact" })
      .eq("id", id).eq("client_id", clientId);
    if (error) return dbFail(req, clientId, "delete that location", error);
    if (!count) return json({ error: "Location not found." }, 404);
    return json({ ok: true });
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
      unitIds.length
        ? admin.from("designs")
          .select("short_code, inventory_unit_id, contact, status, ghl_estimate_number, created_at")
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
    const estsByUnit = new Map<string, any[]>();
    for (const d of estRes.data ?? []) {
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
  if (action === "contact_activity") {
    const codes: string[] = Array.isArray(payload?.codes)
      ? payload.codes.map((c: unknown) => String(c)).filter(Boolean).slice(0, 50)
      : [];
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

    const KINDS = new Set(["building", "paint", "roof", "door", "window", "ramp", "layout_item", "custom_option", "discount", "delivery", "fallback"]);

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

      if (!KINDS.has(lineKind)) { skipped.push(`${lineKind || "(blank)"}: unknown line kind`); continue; }
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
      .select("email_provider, email_domain, email_from_local, email_from_name, email_domain_status, email_dns_records, email_verified_at, email_last_error")
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
      domainStatus: s?.email_domain_status ?? "not_configured",
      domain,
      fromName: s?.email_from_name ?? null,
      fromLocal,
      fromAddress: domain ? `${fromLocal}@${domain}` : null,
      verifiedAt: s?.email_verified_at ?? null,
      lastError: s?.email_last_error ?? null,
      active: s?.email_provider === "resend",
      dnsRecords: Array.isArray(s?.email_dns_records) ? s.email_dns_records : [],
      // deno-lint-ignore no-explicit-any
      recentSends: (sends ?? []).map((r: any) => ({
        id: r.id, kind: r.kind, to: r.to_email, status: r.status,
        error: r.error ?? null, bounceReason: r.bounce_reason ?? null, createdAt: r.created_at,
      })),
    });
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
    if (!/^(?!-)[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(domain)) {
      return json({ error: "That doesn't look like a domain — enter just the part after the @, like yourbusiness.com." }, 400);
    }
    const PLATFORM_APEXES = ["structurestudiosuite.com", "structurestudio.app"];
    if (PLATFORM_APEXES.some((apex) => domain === apex || domain.endsWith(`.${apex}`))) {
      return json({ error: "That domain belongs to StructureStudio — connect your own business domain instead." }, 400);
    }
    const fromLocalRaw = String(payload?.fromLocal ?? "").trim().toLowerCase();
    if (fromLocalRaw && !/^[a-z0-9._%+-]{1,64}$/.test(fromLocalRaw)) {
      return json({ error: "The from address can only contain letters, numbers and . _ % + - (just the part before the @)." }, 400);
    }
    const fromLocal = fromLocalRaw || "info";
    const fromName = String(payload?.fromName ?? "").trim().slice(0, 120) || null;

    // Someone else already holds this domain? Refuse BEFORE creating anything on the
    // provider; the unique-index catch below stays as the race-proof backstop.
    const { data: holder, error: holderErr } = await admin
      .from("client_settings").select("client_id")
      .eq("email_domain", domain).neq("client_id", clientId).maybeSingle();
    if (holderErr) return dbFail(req, clientId, "check that domain", holderErr);
    if (holder) return json({ error: "That domain is already connected to another account." }, 409);

    const { data: cur, error: curErr } = await admin
      .from("client_settings").select("email_domain, resend_domain_id")
      .eq("client_id", clientId).maybeSingle();
    if (curErr) return dbFail(req, clientId, "read your email sending settings", curErr);

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
    const domainStatus = verified ? "verified" : "pending";
    const { error: upErr } = await admin.from("client_settings").update({
      email_domain_status: domainStatus,
      email_dns_records: dnsRecords,
      email_verified_at: verified ? new Date().toISOString() : null,
      email_last_error: null,
      updated_at: new Date().toISOString(),
    }).eq("client_id", clientId);
    if (upErr) return dbFail(req, clientId, "save your domain's verification state", upErr);
    return json({ ok: true, verified, domainStatus, dnsRecords });
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
      .from("client_settings").select("resend_domain_id")
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
      updated_at: new Date().toISOString(),
    }).eq("client_id", clientId);
    if (upErr) return dbFail(req, clientId, "disconnect your email domain", upErr);
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
  if (action === "resend_quote_email") {
    const shortCode = String(payload?.shortCode ?? "").trim();
    if (!shortCode) return json({ error: "shortCode is required." }, 400);

    const { data: d, error: dErr } = await admin
      .from("designs")
      .select("short_code, contact, selections, ss_quote_number, ss_quote_pdf_url, image_url, estimate_lines")
      .eq("client_id", clientId).eq("short_code", shortCode).maybeSingle();
    if (dErr) return dbFail(req, clientId, "find that design", dErr);
    if (!d) return json({ error: "Design not found." }, 404);
    if (!d.ss_quote_number) return json({ error: "This design has no StructureStudio quote yet — submit it from the designer first." }, 400);

    const { data: cs, error: csErr } = await admin
      .from("client_settings")
      .select("invoice_in_ghl, business_name, business_phone, business_website, business_logo_url, quote_terms")
      .eq("client_id", clientId).maybeSingle();
    if (csErr) return dbFail(req, clientId, "read your settings", csErr);
    if (!cs || cs.invoice_in_ghl !== false) {
      return json({ error: "This account quotes through the CRM — re-send it from there." }, 400);
    }

    const to = String(d?.contact?.email || "").trim();
    if (!to) return json({ ok: true, sent: false, reason: "no email address on this design" });

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
    return json({ ok: true, sent: outcome.sent, reason: outcome.sent ? null : (outcome.reason || "failed") });
  }

  if (action === "send_invoice") {
    const shortCode = String(payload?.shortCode ?? "").trim();
    if (!shortCode) return json({ error: "shortCode is required." }, 400);

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
        await auditStrict("operator_send_invoice_attempt", null, `short_code=${shortCode}`);
      } catch (e) {
        return json({ error: (e as Error).message }, 503);
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
    const setClaim = (patch: Record<string, unknown>) =>
      admin.from("invoice_sends").update({ ...patch, updated_at: nowIso() })
        .eq("client_id", clientId).eq("short_code", shortCode);
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
        .select("status, invoice_id, invoice_number, updated_at, attempts, sender_user_id")
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
        resendSenderUserId = prior.sender_user_id ? String(prior.sender_user_id) : null;
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

      // ── 3. Resolve the sender BEFORE converting (GHL: "either userId or sentFrom"). ──
      let userId = String(est?.sentBy ?? "");
      if (!userId) {
        const ur = await ghl(`https://services.leadconnectorhq.com/users/?locationId=${encodeURIComponent(locationId)}`, { headers: ghlHeaders });
        const users: any[] = Array.isArray(ur.body?.users) ? ur.body.users : [];
        userId = String(users[0]?.id ?? "");
      }
      if (!userId) {
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
      await setClaim({ status: "created", invoice_id: invoiceId, invoice_number: invoiceNumber, error: null, sender_user_id: userId });

      // ── 5. Email it to the customer — own-domain branch first, GHL's email otherwise.
      //    tryOwnDomainEmail returning false (whatever the reason) lands on the stock GHL
      //    send below unchanged; if send_manually already ran, that second send call is
      //    idempotent (verified live 2026-08-10). ──
      const ownDomainSent = await tryOwnDomainEmail(invoiceId, invoiceNumber, userId, ghlInvoiceTotal);
      if (!ownDomainSent) {
        const sendRes = await ghl(`https://services.leadconnectorhq.com/invoices/${encodeURIComponent(invoiceId)}/send`, {
          method: "POST", headers: ghlHeaders,
          body: JSON.stringify({ altId: locationId, altType: "location", action: "email", liveMode: true, userId }),
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
      let userId = resendSenderUserId || "";
      if (!userId) {
        const ur = await ghl(`https://services.leadconnectorhq.com/users/?locationId=${encodeURIComponent(locationId)}`, { headers: ghlHeaders });
        const users: any[] = Array.isArray(ur.body?.users) ? ur.body.users : [];
        userId = String(users[0]?.id ?? "");
      }
      if (!userId) {
        return json({ error: "Your CRM has no user to send the invoice as — add a user to that sub-account, then retry." }, 400);
      }
      // Own-domain branch first here too — the recovery is only ever about the EMAIL
      //  (the invoice already exists), so the same rule applies: our branded send when the
      //  tenant is Resend-active, the stock GHL email as the unchanged fallback.
      const ownDomainSent = await tryOwnDomainEmail(invoiceId, invoiceNumber, userId, null);
      if (!ownDomainSent) {
        const sendRes = await ghl(`https://services.leadconnectorhq.com/invoices/${encodeURIComponent(invoiceId)}/send`, {
          method: "POST", headers: ghlHeaders,
          body: JSON.stringify({ altId: locationId, altType: "location", action: "email", liveMode: true, userId }),
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
    await pushQboInvoice(admin, clientId, {
      shortCode,
      docNumber: invoiceNumber,
      ghlTotal: ghlInvoiceTotal,
    });

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
}));
