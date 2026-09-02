import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";
import { logEdgeError, withErrorLog } from "../_shared/logError.ts";
import { sendTenantEmail } from "../_shared/emailSend.ts";
import { changeOrderEmail, estimateEmail } from "../_shared/emailTemplates.ts";
import { estimateUrl } from "../_shared/ghlLinks.ts";
import { buildFormalEstimatePdf } from "../_shared/estimatePdf.ts";
import { buildQuotePdf } from "../_shared/quotePdf.ts";
import { myQuotesUrl } from "../_shared/customerPortalUrl.ts";
import { deHtml, round2, subtotalsFromSnapshot, totalFromSnapshot } from "../_shared/estimateLines.ts";
import { agreedBaseline, changeOrderDescription } from "../_shared/changeOrderDiff.ts";
import { addressFrom } from "../_shared/contactAddress.ts";
import { resolveRate, taxOn } from "../_shared/salesTax.ts";
import { chargeTaxCalculation, taxLookupIdem } from "../_shared/taxMeter.ts";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

// SEND ROUTING (step 10; Postmark 2026-08-10, moved to Resend 2026-08-21). Two paths, routed per tenant
// by `client_settings.email_provider`:
//
//  • 'resend' — the GHL send is called with action:"send_manually" (live-verified
//    2026-08-10 on the test location: 201, flips the estimate to 'sent' so the hosted
//    Accept/Reject page and sync-design-status derivation stay intact, sends NO email,
//    and a repeat call is idempotent; the send body REQUIRES userId — 422 without it).
//    Then _shared/emailSend.ts `sendTenantEmail()` delivers our own branded email
//    (_shared/emailTemplates.ts) linking GHL's hosted estimate page (_shared/ghlLinks.ts).
//    sendTenantEmail owns, internally: the dark guards (secrets / provider flag /
//    platform-domain readiness), From resolution (verified tenant domain, else the
//    platform domain), the email_sends ledger, and the BETA REDIRECT for this path —
//    recording the pre-redirect recipient as `intended_email`. If it returns {sent:false}
//    (not active or failed), step 10 falls through to the GHL path below: GHL accepts a
//    second send on an already-'sent' estimate (double-send verified safe), so the
//    customer still gets an email. A formal estimate PDF is generated best-effort on this
//    path only; its failure never blocks the email.
//
//  • 'ghl' (the default) — today's GHL action:"email" send, byte-identical to the
//    pre-own-domain behavior. On THIS path the beta redirect happens right in step 10 by
//    replacing the recipient list.
//
// BETA MODE REDIRECT (restored 2026-08-07, Carolyn's call).
//
// When the tenant's own `beta_mode` switch is on, the estimate email goes to that
// tenant's OWN `beta_email` test inbox instead of the customer — on BOTH paths, in the
// two places named above. This is what the portal's Testing card has always claimed;
// between the removal of the first redirect and this change it was a false promise, and
// testing with a real lead's details emailed that lead a live branded quote.
//
// The first redirect was removed because it pointed at a single hard-coded QA address
// that was NOT deliverable, so beta estimates silently failed to send. Two rules keep
// this version from repeating that:
//
//   1. The address is the TENANT'S OWN, set by them in Settings — not a global constant
//      nobody owns. It is validated as an email on save and again here.
//   2. Beta mode with no usable test inbox REFUSES the submission (before any GHL contact,
//      opportunity, or estimate is created) rather than falling back to the customer.
//      A silent fallback is precisely the hazard this exists to remove, and a silent
//      no-send is how the first version failed. Loud beats either.
//
// The request's `betaMode` flag is NOT part of this. It is derived from the deploy host
// and remains telemetry — see `redirectToTestInbox` below for why coupling them would
// break every beta-host submission for tenants who never opted in.
//
// `sendDebug.sentTo` and the response's `betaRedirected` report where it actually went;
// `sendDebug.provider` says which sender delivered it.

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...cors, "Content-Type": "application/json" },
  });
}

// Deliberately permissive: this is a "did someone paste something that is obviously not
// an address" check, not an RFC 5322 parser. It exists so beta mode cannot be armed with
// a value that GHL will silently drop — the same failure mode that killed the first
// redirect. Kept in step with portal-settings' save-side check.
const isEmail = (v: string): boolean => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v);

// deHtml moved to _shared/estimateLines.ts (2026-08-24): the SS invoice in portal-settings
// renders the same estimate_lines snapshot and must de-render it identically.

Deno.serve(withErrorLog("submit-estimate", async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  let payload: any;
  try { payload = await req.json(); }
  catch { return json({ error: "Invalid JSON" }, 400); }

  const { designId, clientId, contact, selections, itemSummary, roughOpenings, customOptions, doors, ramps, windows, imageUrl, planImageUrl, view3dImageUrl, betaMode, deliveryFee, declinedItems, discounts } = payload || {};

  // Mirrors n8n strict validation
  const missing: string[] = [];
  if (!selections?.buildingStyle?.toString?.().trim()) missing.push("buildingStyle");
  if (!selections?.buildingSize?.toString?.().trim()) missing.push("buildingSize");
  if (missing.length) return json({ error: `Missing required selections: ${missing.join(", ")}` }, 400);
  if (!clientId) return json({ error: "Missing clientId" }, 400);
  if (!designId) return json({ error: "Missing designId" }, 400);

  // Service-role client. Bypasses RLS so it can read client_settings (which holds the GHL
  // API key and is locked down to service role) and write back GHL IDs.
  const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const supabase = createClient(supabaseUrl, serviceKey);

  // 1. GHL credentials + business identity for this client. The business_* columns are
  //    nullable (the portal can save them piecemeal), so null credentials are treated the
  //    same as a missing row.
  const { data: settings, error: settingsErr } = await supabase
    .from("client_settings")
    .select("ghl_location_id, ghl_api_key, ghl_pipeline_id, ghl_stage_send_quote_id, business_name, business_phone, business_website, business_address, business_logo_url, quote_terms, beta_mode, beta_email, ramp_price, ramp_price_method, ramp_image_url, ramp_show_image, email_provider, email_domain_status, email_domain, email_from_local, email_from_name, invoice_in_ghl, email_template_copy, ss_tax_rate, ss_tax_label, ss_tax_delivery")
    .eq("client_id", clientId)
    .single();
  if (settingsErr || !settings || !settings.ghl_location_id || !settings.ghl_api_key) {
    return json({ error: `No GHL credentials configured for client "${clientId}". Ask an admin to set them via the admin panel.` }, 400);
  }
  const locationId = settings.ghl_location_id;
  const apiKey = settings.ghl_api_key;
  const pipelineId: string | null = settings.ghl_pipeline_id || null;
  const sendQuoteStageId: string | null = settings.ghl_stage_send_quote_id || null;

  // Per-client business identity shown on the estimate PDF/email. Onboarding should
  // populate these for every tenant; the fallbacks just keep the function from
  // emitting broken payloads when a field was never set.
  const businessName: string = settings.business_name || clientId;
  const businessPhone: string = settings.business_phone || "";
  const businessWebsite: string = settings.business_website || "";
  const businessAddress: any = settings.business_address || null;
  const businessLogoUrl: string = settings.business_logo_url || "";
  const quoteTerms: string = settings.quote_terms || "";
  // WHO ISSUES THE PAPERWORK (migration 121). Default TRUE — and read as "anything but an
  // explicit false is the CRM", so a tenant whose row predates the column, or whose value is
  // null for any reason, gets today's GHL path rather than silently switching to a document
  // StructureStudio has never sent for them. The credential check above is deliberately NOT
  // relaxed for SS mode: the contact upsert and the opportunity still go to the CRM either way.
  const invoiceInGhl: boolean = settings.invoice_in_ghl !== false;

  // Sales tax (migration 148) — SS mode only. In CRM mode GHL's own tax engine computes it from
  // automaticTaxesEnabled and the line tax categories, so none of this is read on that path and
  // no snapshot on it gains a `tax` key.
  const ssTaxRate: number | null = settings.ss_tax_rate == null ? null : Number(settings.ss_tax_rate);
  const ssTaxLabel: string = String(settings.ss_tax_label || "Sales tax");
  const ssTaxDelivery: boolean = settings.ss_tax_delivery === true;
  const effectiveBetaMode: boolean = Boolean(betaMode) || Boolean(settings.beta_mode);

  // ⚠️ ONLY the tenant's own `beta_mode` switch redirects. The request's `betaMode` flag is
  // derived from the deploy HOST (`beta.*` on either apex, a `beta--*` preview) and stays
  // telemetry, exactly as it was: nobody opted into it, so letting it divert mail would
  // silently stop every beta-host estimate for every tenant — including ones with no test
  // inbox, who would get a hard failure instead of a working quote. `effectiveBetaMode`
  // keeps its old meaning for the response; this is a deliberately narrower flag.
  const redirectToTestInbox: boolean = Boolean(settings.beta_mode);

  // Resolved NOW, before anything is created in GHL. Beta mode with no usable address is a
  // configuration error, not a reason to email the customer — see rule 2 in the header.
  // Failing here means a rejected test leaves no contact, opportunity, or estimate behind.
  const betaEmail: string = String(settings.beta_email ?? "").trim();
  if (redirectToTestInbox && !isEmail(betaEmail)) {
    return json({
      error: betaEmail
        ? `Beta mode is on for "${clientId}" but its test inbox is not a valid email address. Fix it in Settings → Branding → Testing, or turn beta mode off.`
        : `Beta mode is on for "${clientId}" but no test inbox is set. Add one in Settings → Branding → Testing, or turn beta mode off. (Nothing was sent — beta mode never falls back to emailing the customer.)`,
      betaMode: true,
    }, 400);
  }

  const ghlHeaders: Record<string, string> = {
    "Version": "2021-07-28",
    "Authorization": `Bearer ${apiKey}`,
    "Content-Type": "application/json",
    "Accept": "application/json",
  };

  // 2. Existing GHL IDs (decides create vs update). The design row was upserted by the
  //    browser right before calling us, so it must exist here.
  const { data: existingDesign, error: designErr } = await supabase
    .from("designs")
    // accepted_snapshot (153) is the change-order baseline. It MUST be selected here: this
    // handler overwrites estimate_lines below, so estimate_lines cannot be that baseline.
    .select("client_id, ghl_contact_id, ghl_estimate_id, ghl_estimate_number, ghl_opportunity_id, ss_quote_number, accepted_at, estimate_lines, accepted_snapshot")
    .eq("short_code", designId)
    .single();
  if (designErr || !existingDesign) {
    return json({ error: `Design ${designId} not found in Supabase` }, 404);
  }
  // Cross-tenant guard: the design must belong to the clientId in the request. Without this,
  // an anon caller could pass another tenant's clientId + a known design code and drive
  // estimates (and customer emails) through the victim tenant's GHL account.
  if (existingDesign.client_id && existingDesign.client_id !== clientId) {
    return json({ error: "This design does not belong to the specified client." }, 403);
  }
  const existingEstimateId: string | null = existingDesign.ghl_estimate_id || null;

  // 2c. Staff-only pricing adjustments (audit 2026-08-20). discounts[] and deliveryFee are
  // body-supplied money on an endpoint reachable with the public anon key, and the only
  // gate on them used to be the designer's UI (the "+ Add Discount" / "+ Add Delivery Fee"
  // buttons are embedded-only in structure-studio.component.js). The server never checked,
  // so an anonymous shopper could POST discounts:[{amount:999999}] and zero their own
  // quote, opportunity value, and QuickBooks snapshot. The embedded portal designer calls
  // supabase.functions.invoke with the signed-in rep's JWT (its client shares the portal's
  // persisted session); the public designer sends the bare anon key. So: honour these
  // fields only when the Authorization JWT resolves to a real user who is a member of
  // THIS tenant (client_users) or a platform operator (app_operators — a view-as operator
  // has no client_users row on the viewed tenant). Otherwise STRIP them and log; the
  // submission still goes through at full price, because a shopper must never be blocked
  // by fields they didn't knowingly send. Known, accepted cost: an anonymous re-submit of
  // a rep-built design loses the rep's delivery fee/discounts until a rep resubmits (the
  // stored design row is anon-writable too, so it is no stronger a source than the body).
  const wantsDiscounts = Array.isArray(discounts) && discounts.some((d: any) => Math.abs(Number(d?.amount) || 0) > 0);
  const wantsDeliveryFee = (Number(deliveryFee) || 0) > 0;
  // A custom option marked NON-TAXABLE is a pricing field too (migration 148). Custom options
  // themselves are not gated — they are positive charges, so a shopper adding one only hurts
  // themselves — but taxability runs the other way: left ungated, a shopper could tick their
  // own line non-taxable and shave the tax off their bill. So an untaxed custom option joins
  // discounts and the delivery fee behind the staff check.
  const wantsNonTaxableCustom = Array.isArray(customOptions)
    && customOptions.some((co: any) => co?.taxable === false);
  let allowedDiscounts: any[] = Array.isArray(discounts) ? discounts : [];
  let allowedDeliveryFee: number = Number(deliveryFee) || 0;
  let allowedCustomOptions: any[] = Array.isArray(customOptions) ? customOptions : [];
  let staffCaller = false;
  if (wantsDiscounts || wantsDeliveryFee || wantsNonTaxableCustom) {
    try {
      const token = (req.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "").trim();
      if (token) {
        // The bare anon key is a valid JWT with no `sub`, so getUser() rejects it — the
        // same primary defence _shared/resolveTenant.ts documents for the portal functions.
        const { data: userData } = await supabase.auth.getUser(token);
        const userId = userData?.user?.id;
        if (userId) {
          const [memRes, opRes] = await Promise.all([
            supabase.from("client_users").select("user_id").eq("user_id", userId).eq("client_id", clientId).limit(1),
            supabase.from("app_operators").select("user_id").eq("user_id", userId).maybeSingle(),
          ]);
          staffCaller = Boolean((memRes.data && memRes.data.length) || opRes.data);
        }
      }
    } catch (e) {
      // A failed staff check treats the caller as anonymous — fail CLOSED on money: the
      // quote goes out at full price rather than honouring an unverified discount.
      console.warn("submit-estimate: staff check failed:", (e as Error).message);
    }
    if (!staffCaller) {
      allowedDiscounts = [];
      allowedDeliveryFee = 0;
      // Not emptied — the charges stand; only the tax exemption is refused.
      allowedCustomOptions = allowedCustomOptions.map((co: any) => ({ ...co, taxable: true }));
      // Logged (never thrown) so triage can see stripping happen — a legit rep whose
      // session expired mid-designer shows up here, not as a silently smaller quote.
      logEdgeError({
        fn: "submit-estimate",
        req,
        clientId,
        code: "unauthorized_pricing_fields",
        message: "Anonymous caller sent staff-only pricing fields (discounts/deliveryFee) — stripped; estimate submitted at full price.",
        context: {
          designId: String(designId),
          discountCount: Array.isArray(discounts) ? discounts.length : 0,
          discountTotal: Array.isArray(discounts)
            ? discounts.reduce((s: number, d: any) => s + Math.abs(Number(d?.amount) || 0), 0)
            : 0,
          deliveryFee: Number(deliveryFee) || 0,
        },
      }).catch(() => {});
    }
  }

  // 2b. Address handling. The React form collects street/city/state/zip optionally
  // (only name/email/phone are required). If the customer filled in any address
  // field, push the whole address through to GHL on both the contact upsert and
  // the estimate; if every address field is blank, omit it so we don't blank out
  // an existing address on a returning contact. Country defaults to "US" since the
  // form doesn't collect it yet — add it to contactFields when onboarding a non-US
  // tenant and it'll flow through automatically.
  const hasAddress = Boolean(
    contact?.street || contact?.city || contact?.state || contact?.zip
  );
  const upsertAddress = hasAddress ? {
    address1: contact?.street || "",
    city: contact?.city || "",
    state: contact?.state || "",
    postalCode: contact?.zip || "",
    country: contact?.country || "US",
  } : null;
  const estimateAddress = hasAddress ? {
    addressLine1: contact?.street || "",
    city: contact?.city || "",
    state: contact?.state || "",
    postalCode: contact?.zip || "",
    countryCode: contact?.country || "US",
  } : null;

  // 3. Upsert contact
  let contactId: string | null = existingDesign.ghl_contact_id || null;
  try {
    const r = await fetch("https://services.leadconnectorhq.com/contacts/upsert", {
      method: "POST",
      headers: ghlHeaders,
      body: JSON.stringify({
        name: contact?.name || "",
        email: contact?.email || "",
        phone: contact?.phone || "",
        locationId,
        ...(upsertAddress || {}),
      }),
    });
    if (!r.ok) {
      return json({ error: `Failed to upsert contact: ${r.status} ${await r.text()}` }, 502);
    }
    const d = await r.json();
    contactId = d?.contact?.id || contactId;
  } catch (e) {
    return json({ error: `Contact upsert error: ${(e as Error).message}` }, 502);
  }

  // 4. Fetch GHL products — pricing NEVER comes from GHL (every line item is priced from this
  //    tenant's StructureStudio catalog below). We still read the product list solely to borrow
  //    a userId for the estimate (products[0].createdBy). It's best-effort: a products-API hiccup
  //    must not block an estimate, and userId falls back to the users API. GHL-ESTIMATE PATH
  //    ONLY: the userId (and this lookup feeding it) is consumed solely by the estimate
  //    create/send calls in steps 9/10, which SS-mode tenants (invoice_in_ghl = false, branch
  //    9-ALT) never reach — so they skip the lookups AND the hard userId requirement below,
  //    which used to 400 real SS-mode tenants whose location simply had no assignable user.
  let products: any[] = [];
  if (invoiceInGhl) {
    try {
      const r = await fetch(
        `https://services.leadconnectorhq.com/products/?locationId=${encodeURIComponent(locationId)}`,
        { headers: ghlHeaders }
      );
      if (r.ok) { const d = await r.json(); products = d?.products || []; }
      else console.warn("Products fetch (userId only) failed:", r.status, (await r.text()).slice(0, 300));
    } catch (e) {
      console.warn("Products fetch (userId only) error:", (e as Error).message);
    }
  }

  const dynamicLocationId = (products[0]?.locationId) || locationId;

  // 5b. Resolve the GHL userId the estimate is assigned to. GHL's estimate API rejects an
  // empty userId ("userId should not be empty"). Resolution order:
  //   1. products[0].createdBy   — borrow from an existing product (how prod/Junior Barns works)
  //   2. GET /users/?locationId= — first user in the location
  // If both come up empty (e.g. a brand-new GHL location with no products and no assigned
  // users), we fail early with an actionable message instead of GHL's cryptic 422. In SS mode
  // no GHL estimate is ever created, so the id stays "" and nothing requires it (the contact
  // upsert and the opportunity never take a userId).
  let dynamicUserId = (products[0]?.createdBy) || "";
  if (invoiceInGhl && !dynamicUserId) {
    try {
      const r = await fetch(
        `https://services.leadconnectorhq.com/users/?locationId=${encodeURIComponent(locationId)}`,
        { headers: ghlHeaders }
      );
      if (r.ok) {
        const d = await r.json();
        const users: any[] = Array.isArray(d?.users) ? d.users : [];
        dynamicUserId = users[0]?.id || users[0]?._id || "";
      } else {
        console.warn("userId fallback (users fetch) failed:", r.status, (await r.text()).slice(0, 500));
      }
    } catch (e) {
      console.warn("userId fallback (users fetch) error:", (e as Error).message);
    }
  }
  if (invoiceInGhl && !dynamicUserId) {
    // This endpoint is reachable with the public anon key, so the caller-facing message must not
    // carry the tenant's ghl_location_id — it lives in the service-role-only client_settings and
    // every other surface deliberately masks it (portal-settings' maskId, admin-save-settings'
    // slice). The full id goes to the server-side log instead, where triage can still see it.
    console.warn(`submit-estimate: GHL location has no assignable user (client=${clientId} location=${locationId})`);
    return json({
      error: `Can't create the estimate: this business's CRM location has no user to assign it to. ` +
        `GHL requires a userId. Assign at least one user to that GHL sub-account (and ideally add a product for pricing), ` +
        `or set an explicit GHL user id in the client's settings, then resubmit.`,
    }, 400);
  }

  // 7. Build line items — every amount comes from this tenant's StructureStudio catalog
  //    (building_sizes for the building, layout_item_pricing for add-ons). GHL products are
  //    never consulted for pricing.
  const summary = itemSummary || {};
  const targetItems: any[] = [];

  // ── Line provenance (QuickBooks push, migration 066) ────────────────────────────
  // Which catalog concept produced each line, recorded as it is built — it is not
  // recoverable afterwards (a line's name is tenant-authored text). Kept in a SIDE map
  // rather than on the line objects, so nothing foreign can leak into the GHL payload.
  // Serialized into designs.estimate_lines at step 11, AFTER pct_estimate_total
  // resolution and credit baking have finalized the amounts (both mutate in place).
  // A line no site tagged serializes as kind "fallback" — the push's safety net.
  const lineProv = new Map<any, { kind: string; itemKey?: string; nonTaxable?: boolean; skip?: boolean }>();
  const tagLine = <T,>(line: T, p: { kind: string; itemKey?: string; nonTaxable?: boolean; skip?: boolean }): T => {
    lineProv.set(line, p);
    return line;
  };

  // Per-line product image (the "image inside the app" the owner uploaded → shown on the
  // estimate line). Images live in this tenant's public 'branding' bucket; only attach a URL
  // under that tenant prefix so a tampered catalog row can't graft an arbitrary link onto the
  // branded estimate. GHL renders a line item's attachments as the product photo.
  const brandingPrefix = `${supabaseUrl}/storage/v1/object/public/branding/${clientId}/`;
  // Door photos live in the 'fixtures' bucket; styles/layout images in 'branding'. Both are
  // tenant-scoped under {clientId}/, which is the guard that matters.
  const fixturesPrefix = `${supabaseUrl}/storage/v1/object/public/fixtures/${clientId}/`;
  // GHL line-item attachments are an array of plain image-URL STRINGS (proven by the working
  // n8n payload: `attachments: [imageUrl]`). An array of objects is rejected. Only attach a
  // URL under this tenant's own storage prefix so a tampered catalog row can't inject a link.
  const imgAttachments = (url: unknown): string[] => {
    const u = String(url || "");
    if (!u || !(u.startsWith(brandingPrefix) || u.startsWith(fixturesPrefix))) return [];
    return [u];
  };

  const style = selections.buildingStyle || "";
  const size = selections.buildingSize || "";
  const paintStatus = (selections.paint && String(selections.paint).toLowerCase() === "painted") ? "Paint" : "Unpaint";

  // Building price — always from this tenant's StructureStudio catalog (building_sizes.base_price).
  // The designer submits the style's KEY (e.g. "test"), not its label ("Test"), and sizes can
  // render with × vs x. Normalize both sides (lowercase, ×→x, strip spaces) and match the style
  // by key OR label so the price reliably resolves. styleRowId is reused below for any
  // style-specific layout_item_pricing overrides.
  const norm = (s: unknown) => String(s ?? "").toLowerCase().replace(/[×✕]/g, "x").replace(/\s+/g, "");
  let styleRowId: string | null = null;
  let sizeRowId: string | null = null;       // reused below for the size's included-item quantities
  let styleLabel = style;            // display-name fallback if the style row isn't found
  let styleImageUrl: string | null = null;   // building-style photo, attached to the building line
  let styleShowImage = true;                 // per-style toggle: attach the photo to the estimate? (default yes)
  let buildingPrice = 0, priced = false;
  let buildingWidthFt = 0, buildingDepthFt = 0;   // drive sqft_building / perimeter_building add-ons

  // ── Taxability, per catalog item (migration 148) ────────────────────────────────────────
  //
  // Read ONCE, tenant-wide, and only in SS mode — the GHL path issues exactly the queries it
  // always did. Three whole-catalog reads rather than adding `taxable` to the six existing
  // `.in("id", …)` selects: a tenant's catalogs are tens of rows, the maps are wanted at a
  // dozen tagLine sites scattered over 700 lines, and one place to look is worth more here
  // than three saved row-reads.
  //
  // ABSENT MEANS TAXABLE, everywhere. The column defaults true, so a missing map entry can
  // only mean a row this code did not read — and silently exempting something the builder
  // never exempted is the failure that shows up as an under-collected return.
  const layoutTaxable = new Map<string, boolean>();
  const fixtureTaxable = new Map<string, boolean>();
  const colorTaxable = new Map<string, boolean>();
  let styleTaxable = true;
  if (!invoiceInGhl) {
    try {
      const [lt, ft, ct] = await Promise.all([
        supabase.from("client_layout_items").select("item_key, taxable").eq("client_id", clientId),
        supabase.from("fixture_items").select("id, taxable").eq("client_id", clientId),
        supabase.from("colors").select("id, taxable").eq("client_id", clientId),
      ]);
      for (const r of (lt.data || []) as any[]) layoutTaxable.set(String(r.item_key), r.taxable !== false);
      for (const r of (ft.data || []) as any[]) fixtureTaxable.set(String(r.id), r.taxable !== false);
      for (const r of (ct.data || []) as any[]) colorTaxable.set(String(r.id), r.taxable !== false);
    } catch (e) {
      // A failed read leaves every map empty, which reads as "everything taxable" — the safe
      // direction. Logged rather than swallowed: a builder whose exemptions silently stopped
      // applying needs to find out from us, not from an auditor.
      console.warn("taxability read failed; treating all lines as taxable:", (e as Error)?.message);
    }
  }

  try {
    const stRes = await supabase.from("building_styles").select("id, key, label, image_url, show_image_on_estimate, taxable").eq("client_id", clientId);
    const styleRow = (stRes.data || []).find((r: any) => norm(r.key) === norm(style) || norm(r.label) === norm(style));
    if (styleRow) {
      styleRowId = styleRow.id;
      styleLabel = styleRow.label || style;
      styleImageUrl = styleRow.image_url || null;
      styleShowImage = styleRow.show_image_on_estimate !== false;
      styleTaxable = styleRow.taxable !== false;
      const szRes = await supabase.from("building_sizes").select("id, base_price, label, width_ft, length_ft").eq("client_id", clientId).eq("style_id", styleRow.id);
      const sizeRow = (szRes.data || []).find((z: any) => norm(z.label) === norm(size));
      if (sizeRow && sizeRow.base_price != null) {
        sizeRowId = sizeRow.id;
        buildingPrice = Number(sizeRow.base_price) || 0; priced = true;
        buildingWidthFt = Number(sizeRow.width_ft) || 0;
        buildingDepthFt = Number(sizeRow.length_ft) || 0;   // building "depth" is stored as length_ft
      }
    }
  } catch { /* leave unpriced; handled below */ }
  // Fail loudly instead of emailing a $0 quote when the size has no price set.
  if (!priced) {
    return json({ error: `No price is set for "${style} ${size}". Add it in the portal Pricing tab, then resubmit.` }, 400);
  }

  // Self-heal legacy building-style images. Tenants seeded from the old single-tenant
  // config carry building_styles.image_url as an inline `data:` URI, which the
  // tenant-prefix guard in imgAttachments() rightly rejects — so those estimates rendered
  // the building line with NO photo (Junior Barns bug report, 2026-07-06). On first use,
  // decode the image, upload it to the public branding bucket under this tenant's prefix,
  // persist the hosted URL back to building_styles, and attach that URL. Non-fatal on
  // failure — worst case the line stays imageless, exactly as before.
  if (styleShowImage && styleRowId && styleImageUrl && styleImageUrl.startsWith("data:")) {
    try {
      const m = /^data:([^;]+);base64,(.*)$/s.exec(styleImageUrl);
      const EXT: Record<string, string> = { "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp", "image/gif": "gif" };
      if (m && EXT[m[1]]) {
        const bytes = Uint8Array.from(atob(m[2]), (c) => c.charCodeAt(0));
        const slug = norm(style).replace(/[^a-z0-9]+/g, "-") || "style";
        const path = `${clientId}/style-${slug}-migrated.${EXT[m[1]]}`;
        const up = await supabase.storage.from("branding").upload(path, bytes, { contentType: m[1], upsert: true });
        if (!up.error) {
          const { data: pub } = supabase.storage.from("branding").getPublicUrl(path);
          if (pub?.publicUrl) {
            await supabase.from("building_styles")
              .update({ image_url: pub.publicUrl, updated_at: new Date().toISOString() })
              .eq("client_id", clientId).eq("id", styleRowId);
            styleImageUrl = pub.publicUrl;
          }
        } else {
          console.warn("style-image self-heal upload failed:", up.error.message);
        }
      } else {
        console.warn("style-image self-heal: unsupported data URI; leaving line imageless");
      }
    } catch (e) {
      console.warn("style-image self-heal error:", (e as Error).message);
    }
  }
  // Building is line 1. Paint + roof used to ride in this name/description; they are now their
  // own line items (2 = Paint Colors, 3 = Roof) pushed immediately below, so any charge on them
  // shows as a real line rather than buried text.
  // Credits (declined items + negative custom options) are baked into THIS line's amount so the
  // taxable base drops by the FULL credit. A fixed invoice discount would instead prorate onto the
  // non-taxable delivery and under-reduce tax. We keep a reference and finalize amount + description
  // after every credit is tallied (below). The item NAME stays the plain building name; the
  // original price + itemized credits go in the DESCRIPTION.
  let bakedCredit = 0;               // total DECLINED-item credit to subtract from the building line
  const creditNotes: string[] = [];  // per-declined-item notes appended to the building description
  let creditOverflow = 0;            // declined credit beyond the building price → falls back to a discount
  let discountTotal = 0;             // "+ Add Discount" rows → GHL invoice discount total
  // The same rows, kept individually with the taxability the rep chose (migration 148). The
  // collapsed `discountTotal` cannot carry it, and prorating one across both pools was
  // explicitly rejected — Carolyn 2026-08-27, "discounts should select whether they are
  // taxable or not. never assume."
  const ssDiscountRows: { description: string; amount: number; taxable: boolean }[] = [];
  const buildingLine: any = {
    name: `${styleLabel} (${size})`,
    qty: 1,
    amount: buildingPrice,
    priceId: "",
    productId: "",
    attachments: styleShowImage ? imgAttachments(styleImageUrl) : [],
    currency: "USD",
    type: "one_time",
    description: "",   // size lives in the name; filled with the credit breakdown only when items are declined
  };
  targetItems.push(tagLine(buildingLine, { kind: "building", nonTaxable: !styleTaxable }));

  // Add-on pricing — always from this tenant's layout_item_pricing table (keyed by item_key).
  // A style-specific override (style_id = the selected style) wins over the style_id IS NULL
  // default. Items without a configured row price at $0.
  const layoutRates = new Map<string, { method: string; rate: number; imageUrl: string | null }>();
  try {
    const lpRes = await supabase
      .from("layout_item_pricing")
      .select("item_key, style_id, pricing_method, rate, image_url")
      .eq("client_id", clientId);
    for (const r of (lpRes.data || []) as any[]) {
      if (r.style_id && r.style_id !== styleRowId) continue;   // a different style's override — ignore
      const existing = layoutRates.get(r.item_key);
      if (!existing || r.style_id) {                            // override (style_id set) wins over the default
        layoutRates.set(r.item_key, {
          method: String(r.pricing_method),
          rate: Number(r.rate) || 0,
          // the product image lives on the DEFAULT (style_id NULL) row; don't let an
          // imageless style-override clear it.
          imageUrl: r.image_url || existing?.imageUrl || null,
        });
      } else if (!existing.imageUrl && r.image_url) {
        existing.imageUrl = r.image_url;
      }
    }
  } catch { /* no layout pricing → add-ons stay $0 */ }

  // Per-size included quantities (building_size_inclusions.qty, keyed by item_key). Included
  // quantity is part of the base building price, so a placed included item is NOT charged for
  // the included portion — only the amount placed BEYOND it. Fully-included items show as a
  // $0 "(included)" line; declined includes are credited (see below). Rows imported before the
  // quantity feature default to qty 1.
  const includedMap = new Map<string, number>();
  if (sizeRowId) {
    try {
      // An ARCHIVED option no longer counts as "included" — it's retired from new builds, so its
      // base-price inclusion must not net on the quote (matches get_config, which drops the same
      // rows from sizeInclusionQty). Skip any inclusion whose item_key is an archived built-in
      // (client_layout_items.archived) or archived catalog fixture (fixture_items.archived).
      const [archLayout, archFix] = await Promise.all([
        supabase.from("client_layout_items").select("item_key").eq("client_id", clientId).eq("archived", true),
        supabase.from("fixture_items").select("id").eq("client_id", clientId).eq("archived", true),
      ]);
      const archivedKeys = new Set<string>([
        ...((archLayout.data || []) as any[]).map((r) => String(r.item_key)),
        ...((archFix.data || []) as any[]).map((r) => String(r.id)),
      ]);
      const incRes = await supabase.from("building_size_inclusions").select("item_key, qty").eq("size_id", sizeRowId).eq("included", true);
      for (const r of (incRes.data || []) as any[]) {
        if (archivedKeys.has(String(r.item_key))) continue;
        includedMap.set(String(r.item_key), Math.max(1, Number(r.qty) || 1));
      }
    } catch { /* no inclusions → everything placed is charged as-is */ }
  }

  // Building geometry available to area/perimeter pricing methods.
  const buildingArea = buildingWidthFt * buildingDepthFt;             // sqft_building
  const buildingPerimeter = 2 * (buildingWidthFt + buildingDepthFt);  // perimeter_building

  // ── Electrical package ─────────────────────────────────────────────────────
  // Carolyn's rule: "removing one doesn't discount it, extras charged per device."
  //     charge = package + SUM over device types of max(0, placed - auto) * rate
  // The auto counts are RECOMPUTED here from this building's dimensions and the tenant's own
  // stored standards — never taken from the body, which sends only a boolean. Trusting a count
  // from the browser would let a forged payload claim a huge standard layout and make every
  // extra device free.
  //
  // They are then merged into includedMap, so the netting and the "(included)" $0 line come
  // from pushItem exactly as they do for a size inclusion. That is the whole reason this rule
  // needed no new pricing code: max(0, placed - included) already IS "removing never discounts".
  let electricalPkg: { label: string; price: number; taxable: boolean; includePanel: boolean;
                       panelHeightIn: number; outletSpacingFt: number; lightSpacingFt: number } | null = null;
  if (selections?.electrical === true) {
    const esRes = await supabase.from("electrical_settings")
      .select("enabled, package_price, package_label, taxable, include_panel, panel_height_in, outlet_spacing_ft, light_spacing_ft")
      .eq("client_id", clientId).maybeSingle();
    // Refuse rather than silently price nothing — the same posture as an unpriced size.
    if (esRes.error) {
      return json({ error: "Could not read your electrical settings just now. Try resubmitting in a moment." }, 400);
    }
    const es = esRes.data as {
      enabled: boolean; package_price: number | null; package_label: string | null;
      taxable: boolean | null; include_panel: boolean | null; panel_height_in: number | null;
      outlet_spacing_ft: number | null; light_spacing_ft: number | null } | null;
    if (!es || es.enabled !== true) {
      return json({ error: "The electrical package isn't switched on for this account. Turn it on in the portal under Settings → Options → Electrical, then resubmit." }, 400);
    }
    if (es.package_price == null) {
      return json({ error: "The electrical package has no price set, so it can't be quoted. Set it in the portal under Settings → Options → Electrical." }, 400);
    }
    const outletSp = Number(es.outlet_spacing_ft) > 0 ? Number(es.outlet_spacing_ft) : 6;
    const lightSp = Number(es.light_spacing_ft) > 0 ? Number(es.light_spacing_ft) : 10;
    // MIRRORS electricalAutoCounts in the designer twins, line for line — floor for outlets
    // around the perimeter, round for lights along the length, exactly one switch. If one side
    // is ever changed, change both: a mismatch shows the customer one number and bills another.
    const autoCounts: Record<string, number> = {
      outlet: Math.max(1, Math.floor(buildingPerimeter / outletSp)),
      lightFixture: Math.max(1, Math.round(buildingDepthFt / lightSp)),
      lightSwitch: 1,
    };
    for (const k of Object.keys(autoCounts)) {
      includedMap.set(k, (includedMap.get(k) || 0) + autoCounts[k]);
    }
    electricalPkg = {
      label: es.package_label || "Electrical Package",
      price: Number(es.package_price),
      taxable: es.taxable !== false,
      includePanel: es.include_panel !== false,
      panelHeightIn: Number(es.panel_height_in) || 60,
      outletSpacingFt: outletSp,
      lightSpacingFt: lightSp,
    };
  }

  // ── Taller walls (172) ──────────────────────────────────────────────────────────────────
  // A SELECTION charge, not a placed item: nothing is on the floor plan, so this deliberately
  // sits outside pushItem and outside the inclusion / declined-item machinery entirely. The
  // customer picks ONE increase for the whole building and it is charged per lineal foot of
  // perimeter — Carolyn's Lofted Barn +6" at $2/lf on a 12x24 is 72 lf x $2 = $144.
  //
  // The rate is re-read from the table here and NEVER taken from the payload: get_config
  // publishes it to an anonymous browser, so a forged body could otherwise price its own
  // upgrade. An increase that is not offered, not active, or not priced is a hard 400 — the
  // same posture as an unpriced size above, and for the same reason: emailing a quote that
  // silently charged $0 for a real structural change is worse than refusing to send one.
  // Resolved wall height in feet — the style's standard plus whatever increase was chosen.
  // Insulation's WALL area depends on it, which is why taller walls had to land first.
  let resolvedWallHeightFt = 8;
  const wallHeightDeltaIn = Number(selections.wallHeightDeltaIn) || 0;
  if (wallHeightDeltaIn > 0) {
    if (!styleRowId) {
      return json({ error: `Cannot price a wall-height upgrade: the style "${style}" is not in your catalog.` }, 400);
    }
    const whRes = await supabase.from("style_wall_heights")
      .select("delta_in, rate_per_lf, taxable, active, widths_ft")
      .eq("client_id", clientId).eq("style_id", styleRowId).eq("delta_in", wallHeightDeltaIn).maybeSingle();
    const wh = whRes.data as { rate_per_lf: number | null; taxable: boolean | null; active: boolean; widths_ft: number[] | null } | null;
    if (whRes.error || !wh || !wh.active || wh.rate_per_lf == null) {
      return json({ error: `A ${wallHeightDeltaIn}" wall-height increase isn't offered on "${styleLabel}". Set it in the portal under Settings → Options → Wall Height Upgrades, then resubmit.` }, 400);
    }
    // Offered on this WIDTH? Total haul height is wall + roof and the roof grows with width, so
    // an increase legal on an 8 wide can be illegal on a 14. The browser already filters the
    // picker, but this is the check that counts: the payload is attacker-controlled, and a
    // building that cannot be hauled is not a quote we can honour. NULL widths_ft = every width.
    if (Array.isArray(wh.widths_ft) && !wh.widths_ft.some((w) => Number(w) === buildingWidthFt)) {
      return json({ error: `A ${wallHeightDeltaIn}" wall-height increase isn't available on a ${buildingWidthFt} ft wide "${styleLabel}" — taller walls are limited by width for hauling. Choose standard height or a narrower building.` }, 400);
    }
    const whRate = Number(wh.rate_per_lf) || 0;
    resolvedWallHeightFt = Math.max(5, Math.min(14, resolvedWallHeightFt + wallHeightDeltaIn / 12));
    targetItems.push(tagLine({
      name: `Taller Walls (+${wallHeightDeltaIn} in)`,
      qty: buildingPerimeter,
      amount: whRate,
      priceId: "",
      productId: "",
      attachments: [],
      currency: "USD",
      type: "one_time",
      description: `${buildingPerimeter} ft of wall at $${whRate.toFixed(2)} per foot`,
    }, { kind: "wall_height", nonTaxable: wh.taxable === false }));
  }

  // ── Insulation (177) ────────────────────────────────────────────────────────────────────
  // The second SELECTION charge, and it copies the wall-height shape exactly: nothing is placed
  // on the plan, so it sits outside pushItem and outside the inclusion / declined-item
  // machinery. One line per area, which is what makes "entire building" a UI shortcut rather
  // than a stored fourth rate — three ticks produce three lines here either way.
  //
  // Every rate is re-read from the catalog and every square footage is re-derived. The browser
  // never sees a rate at all for insulation, so there is nothing to forge; but the AREAS come
  // from the payload, and an area that is not offered is a hard 400 rather than a silent skip.
  const insSel = Array.isArray(selections.insulation) ? selections.insulation : [];
  if (insSel.length) {
    if (!styleRowId) {
      return json({ error: `Cannot price insulation: the style "${style}" is not in your catalog.` }, 400);
    }
    // The master switch is checked HERE too, not just in get_config. A tenant who turned
    // insulation off should not be billable for it by a stale browser tab or a forged body.
    const insOn = await supabase.from("client_settings").select("insulation_enabled").eq("client_id", clientId).maybeSingle();
    if (insOn.error || !insOn.data || insOn.data.insulation_enabled !== true) {
      return json({ error: "Insulation isn't switched on for this account. Turn it on in the portal under Settings → Options → Insulation, then resubmit." }, 400);
    }
    const ioRes = await supabase.from("insulation_offerings")
      .select("ins_type, area, rate_per_sqft, taxable, active").eq("client_id", clientId);
    // Refuse rather than price nothing: a read failure here would otherwise drop a real charge
    // off the quote silently, which is the same hazard the unpriced-size 400 exists for.
    if (ioRes.error) return json({ error: "Could not read your insulation rates just now. Try resubmitting in a moment." }, 400);
    const offers = (ioRes.data ?? []) as { ins_type: string; area: string; rate_per_sqft: number | null; taxable: boolean | null; active: boolean }[];
    const AREA_LABEL: Record<string, string> = { floor: "Floor", walls: "Walls", roof: "Roof" };
    const TYPE_LABEL: Record<string, string> = { batt: "Batt", spray_foam: "Spray Foam" };
    // roof == floor is the v1 simplification the builder's rate absorbs; walls are GROSS
    // (perimeter x height, no opening deduction). The browser's insulationSqft is the same
    // three lines — they must agree or the preview and the quote disagree.
    const sqftOf = (area: string) =>
      area === "walls" ? Math.round(buildingPerimeter * resolvedWallHeightFt) : Math.round(buildingArea);
    // Deduplicate by AREA: one area cannot be insulated twice, and a duplicated entry would
    // otherwise bill it twice over.
    const seenAreas = new Set<string>();
    for (const raw of insSel) {
      const pick = raw as { type?: unknown; area?: unknown };
      const type = String(pick?.type ?? "").trim();
      const area = String(pick?.area ?? "").trim();
      if (!type || !area || seenAreas.has(area)) continue;
      seenAreas.add(area);
      const off = offers.find((o) => o.ins_type === type && o.area === area);
      if (!off || !off.active || off.rate_per_sqft == null) {
        return json({ error: `${TYPE_LABEL[type] || type} insulation isn't offered for the ${AREA_LABEL[area] || area}. Set it in the portal under Settings → Options → Insulation, then resubmit.` }, 400);
      }
      const sqft = sqftOf(area);
      if (sqft <= 0) continue;
      const rate = Number(off.rate_per_sqft) || 0;
      targetItems.push(tagLine({
        name: `${TYPE_LABEL[type] || type} Insulation — ${AREA_LABEL[area] || area}`,
        qty: sqft,
        amount: rate,
        priceId: "",
        productId: "",
        attachments: [],
        currency: "USD",
        type: "one_time",
        description: `${sqft} sq ft at $${rate.toFixed(2)} per sq ft`,
      }, { kind: "insulation", nonTaxable: off.taxable === false }));
    }
  }

  // Resolve a layout add-on to a GHL line item using its configured pricing_method. `amount`
  // is always PER-UNIT; GHL multiplies it by qty. `count` is how many of the item were placed;
  // lengthFt / optionSqft carry the per-measure quantity for the two measured methods:
  //   each               -> qty=count,     amount=rate
  //   lineal_ft          -> qty=totalFeet, amount=rate
  //   sqft_option        -> qty=totalSqft, amount=rate
  //   sqft_building      -> qty=count,     amount=rate × (width×depth)
  //   perimeter_building -> qty=count,     amount=rate × 2(width+depth)
  //   pct_building_price -> qty=count,     amount=(rate/100) × base building price
  //   pct_estimate_total -> qty=count,     amount resolved LAST against the running subtotal
  // An item with no configured pricing row (or rate) lands at $0. GHL products are never consulted.
  const deferredPctLines: { item: any; rate: number }[] = [];
  const pushItem = (
    search: string | string[],
    itemKey: string | undefined,
    description: string,
    measures: { count?: number; lengthFt?: number; optionSqft?: number } = {},
  ) => {
    const searches = Array.isArray(search) ? search : [search];
    const lp = itemKey ? layoutRates.get(itemKey) : null;
    const method = lp?.method || "each";
    const rate = lp?.rate || 0;
    const count = measures.count ?? 1;

    // Placed measure for this pricing method (count / total feet / total sqft).
    const placed = method === "lineal_ft" ? (measures.lengthFt ?? count)
      : method === "sqft_option" ? (measures.optionSqft ?? count)
      : count;
    // The building size includes some of this item already (in the base price), so charge only
    // the portion placed BEYOND the included quantity.
    const includedQty = itemKey ? (includedMap.get(itemKey) || 0) : 0;
    const chargeable = Math.max(0, placed - includedQty);

    // Fully covered by the inclusion → a $0 line so the customer sees it's part of the building
    // at no charge (never a positive charge for an included item).
    if (includedQty > 0 && chargeable <= 0) {
      targetItems.push(tagLine({
        name: `${searches[0]} (included)`, qty: placed, amount: 0,
        priceId: "", productId: "",
        attachments: lp ? imgAttachments(lp.imageUrl) : [],
        currency: "USD", type: "one_time",
        description: description || "Included with this size",
      }, { kind: "layout_item", itemKey: itemKey || "", nonTaxable: layoutTaxable.get(String(itemKey || "")) === false }));
      // Under-placement credit: an AREA item placed SMALLER than its included quantity (e.g. a
      // 32 sq ft loft when 48 is included) credits the shortfall, baked into the building line like
      // a declined item. Scoped to sqft_option to stay in lock-step with the designer (lineal_ft /
      // "each" are NOT under-credited). A placed loft keeps placedKeys.has("loft") true, so the
      // declined loop never double-credits.
      if (placed > 0 && placed < includedQty && method === "sqft_option") {
        const credit = Math.round(rate * (includedQty - placed) * 100) / 100;
        if (credit > 0) {
          bakedCredit += credit;
          creditNotes.push(`${searches[0]} smaller than included: ${includedQty - placed} sq ft credited (−$${credit.toFixed(2)})`);
        }
      }
      return;
    }

    let qty = chargeable;
    let amount = rate;
    switch (method) {
      case "lineal_ft":          amount = rate; break;
      case "sqft_option":        amount = rate; break;
      case "sqft_building":      amount = rate * buildingArea; break;
      case "perimeter_building": amount = rate * buildingPerimeter; break;
      case "pct_building_price": amount = (rate / 100) * buildingPrice; break;
      case "pct_estimate_total": amount = 0; break; // resolved after every other line
      case "each":
      default:                   amount = rate; break;
    }

    // Measured item (loft = sq ft, workbench = ft) charged only on the amount BEYOND its inclusion:
    // the GHL qty cell shows the BILLABLE measure (chargeable), so spell out the full calc in the
    // description — total placed, included in the base price, and billable. GHL's estimate view
    // STRIPS <br> (concatenating the words, e.g. "placed56 sq ft"), so join with " · " — one clean
    // spelled-out line whose spacing survives, matching the designer's live breakdown verbatim.
    let desc = description;
    if (includedQty > 0 && (method === "sqft_option" || method === "lineal_ft")) {
      const u = method === "sqft_option" ? "sq ft" : "ft";
      const breakdown = [
        `${placed} ${u} placed`,
        `${includedQty} ${u} included in base price`,
        `${chargeable} ${u} billable @ $${(Number(rate) || 0).toFixed(2)}/${u}`,
      ].join(" · ");
      desc = desc ? `${desc} · ${breakdown}` : breakdown;
    }

    const item = {
      name: searches[0],
      qty,
      amount,
      priceId: "",
      productId: "",
      attachments: lp ? imgAttachments(lp.imageUrl) : [],
      currency: "USD",
      type: "one_time",
      description: desc,
    };
    targetItems.push(tagLine(item, { kind: "layout_item", itemKey: itemKey || "", nonTaxable: layoutTaxable.get(String(itemKey || "")) === false }));
    if (method === "pct_estimate_total") deferredPctLines.push({ item, rate });
  };

  // Price a single color (paint or roof) by its catalog rate + pricing_method — same math as
  // layout add-ons. pct_estimate_total isn't supported on a combined color line (colors realistically
  // use each / pct_building_price / flat), so it falls back to 0.
  //
  // ⚠️ EXTRACTED COPY EXISTS: _shared/attributeLines.ts carries this function and the
  // paint/roof line builders below verbatim — the order screen's attribute change orders
  // (migration 127) price with it. Any change to this math MUST land in both files.
  const colorAmount = (row: any): number => {
    const rate = Number(row?.rate) || 0;
    if (rate <= 0) return 0;
    switch (String(row?.pricing_method || "each")) {
      case "sqft_building":      return rate * buildingArea;
      case "perimeter_building": return rate * buildingPerimeter;
      case "pct_building_price": return (rate / 100) * buildingPrice;
      case "pct_estimate_total": return 0;
      default:                   return rate;   // each / lineal_ft / sqft_option → flat
    }
  };

  // ── Line 2: Paint Colors ── always present. Body + Trim in the description; amount is the sum
  // of the selected colors' rates (a color used for both sides is charged once).
  {
    let paintAmount = 0;
    let paintDesc = "Unpainted";
    let paintTaxable = true;
    if (paintStatus === "Paint") {
      const b = String(selections.paintBodyColor || "TBD");
      const t = String(selections.paintTrimColor || "TBD");
      paintDesc = `Body: ${b}, Trim: ${t}`;
      try {
        const colRes = await supabase.from("colors")
          .select("id, label, rate, pricing_method, allow_custom")
          .eq("client_id", clientId).eq("active", true);
        const palette = (colRes.data || []) as any[];
        const customRow = palette.find((c) => c.allow_custom);
        // We only reach here when paintStatus === "Paint" (a non-default color was chosen). A
        // named color matches by label; a blank/"TBD" value means the customer picked the Custom
        // option but hasn't typed the exact color yet — that's still a committed charge at the
        // tenant's allow-custom rate (this matches the designer's Details preview, which resolves
        // "TBD" to the Custom color). Only an explicit "No Paint" yields no color.
        const resolve = (val: unknown) => {
          const v = String(val ?? "").trim();
          if (norm(v) === norm("No Paint")) return null;
          return palette.find((c) => norm(c.label) === norm(v)) || customRow || null;
        };
        const seen = new Set<string>();
        // Body and trim collapse into ONE line, so a mixed pair has no representable answer.
        // Resolved conservatively: the line is taxable unless EVERY charged colour on it is
        // exempt. Erring the other way would exempt a taxable colour because the colour beside
        // it was exempt, which under-collects — the one direction that costs the builder.
        let anyPaintTaxable = false;
        for (const row of [resolve(selections.paintBodyColor), resolve(selections.paintTrimColor)]) {
          if (row && !seen.has(row.id)) {
            seen.add(row.id);
            paintAmount += colorAmount(row);
            if (colorTaxable.get(String(row.id)) !== false) anyPaintTaxable = true;
          }
        }
        paintTaxable = seen.size === 0 || anyPaintTaxable;
      } catch { /* colors lookup failed → still emit the line at $0 */ }
    }
    targetItems.push(tagLine({
      name: "Paint Colors", qty: 1, amount: paintAmount, priceId: "", productId: "",
      attachments: [], currency: "USD", type: "one_time", description: paintDesc,
    }, { kind: "paint", nonTaxable: !paintTaxable }));
  }

  // ── Line 3: Roof ── shown whenever the tenant offers roofs (the designer then always sends a
  // roofType key, possibly empty). Type + Color in the description; amount is the roof color's rate.
  if (Object.prototype.hasOwnProperty.call(selections, "roofType")) {
    const roofType = String(selections.roofType ?? "").trim();
    const roofColor = String(selections.roofColor ?? "").trim();
    let roofAmount = 0;
    let roofDesc = "No roof selected";
    let roofTaxable = true;
    if (roofType) {
      roofDesc = roofColor ? `${roofType} — ${roofColor}` : `${roofType} — (color TBD)`;
      if (roofColor && norm(roofColor) !== norm("TBD")) {
        try {
          const flag = norm(roofType) === norm("Metal") ? "metal" : "shingle";
          const colRes = await supabase.from("colors")
            .select("id, label, rate, pricing_method, allow_custom, shingle, metal")
            .eq("client_id", clientId).eq("active", true).eq(flag, true);
          const palette = (colRes.data || []) as any[];
          const customRow = palette.find((c) => c.allow_custom);
          const row = palette.find((c) => norm(c.label) === norm(roofColor)) || customRow || null;
          roofAmount = colorAmount(row);
          if (row) roofTaxable = colorTaxable.get(String(row.id)) !== false;
        } catch { /* colors lookup failed → still emit the line at $0 */ }
      }
    }
    targetItems.push(tagLine({
      name: "Roof", qty: 1, amount: roofAmount, priceId: "", productId: "",
      attachments: [], currency: "USD", type: "one_time", description: roofDesc,
    }, { kind: "roof", nonTaxable: !roofTaxable }));
  }

  if (summary.doubleDoors > 0) pushItem("Double Door", "doubleDoor", "", { count: summary.doubleDoors });
  if (summary.singleDoors > 0) pushItem("Single Door", "singleDoor", "", { count: summary.singleDoors });
  if (summary.windows > 0) pushItem("Window", "window", "", { count: summary.windows });

  // Catalog fixture doors (Options → Doors): priced SERVER-SIDE from fixture_items by
  // fixtureItemId, like every other line on this estimate (audit 2026-08-20). The body's
  // per-door price used to be trusted verbatim ("snapshotted at placement"), which let any
  // anon caller reprice a $500 door to $1 — and that number flowed into the GHL estimate,
  // the opportunity value, and the estimate_lines snapshot QuickBooks invoices verbatim.
  // Identical doors (same name + price) collapse into one line with a qty, matching the
  // designer's live preview. Unpriced / $0 doors add no line (NULL-price contract = not
  // charged). NOT matched against GHL products — pushed as ad-hoc lines like custom options.
  // Size-inclusions for CATALOG fixtures are a SHARED POOL per fixture id, consumed across
  // color-split groups in placement order: a color choice splits one fixture id into several
  // lines, and netting the full inclusion per line would give it away multiple times. The
  // designer's computeLayoutPricingRows runs the identical pool in the identical order so
  // the live preview and this estimate always agree. An included unit nets the whole grouped
  // (base + color) price — included doors don't pay the color surcharge.
  const fxIncRemaining = new Map<string, number>();
  const takeFxIncluded = (fid: string | null, qty: number): number => {
    if (!fid || !includedMap.get(fid)) return 0;
    if (!fxIncRemaining.has(fid)) fxIncRemaining.set(fid, includedMap.get(fid) || 0);
    const take = Math.min(qty, fxIncRemaining.get(fid) || 0);
    fxIncRemaining.set(fid, (fxIncRemaining.get(fid) || 0) - take);
    return take;
  };
  if (Array.isArray(doors)) {
    // Sizes are stored in inches; show them as feet/inches on the estimate line.
    const fmtFtIn = (inches: unknown): string => { const n = Number(inches); if (!isFinite(n) || n <= 0) return ""; const ft = Math.floor(n / 12), inch = Math.round((n - ft * 12) * 100) / 100; return ft === 0 ? `${inch}"` : inch === 0 ? `${ft}'` : `${ft}'${inch}"`; };
    // Each door's price, photo + "show on estimate" flag, read live from the catalog by
    // fixtureItemId — same lookup the declined-fixtures credit below has always done.
    const doorIds = [...new Set(doors.map((d: any) => d && d.fixtureItemId).filter(Boolean))];
    const fxImg = new Map<string, { url: string | null; show: boolean; price: number | null; colorMode: string }>();
    if (doorIds.length) {
      const fr = await supabase.from("fixture_items").select("id, price, image_url, show_image_on_estimate, color_mode").eq("client_id", clientId).in("id", doorIds);
      for (const r of fr.data ?? []) fxImg.set(String(r.id), { url: r.image_url || null, show: r.show_image_on_estimate !== false, price: r.price != null ? Number(r.price) : null, colorMode: String(r.color_mode || "fixed") });
    }
    // Chosen door/trim colors: label + flat per-door rate re-resolved from the tenant's
    // palette by id — same trust posture as the price re-read above (the body's labels are
    // fallback display only, its ids buy nothing unless the row is the tenant's AND ticked
    // for doors; a forged/stale/foreign id prices as $0 with the snapshot label).
    const colorIds = [...new Set(doors.flatMap((d: any) => [d && d.colorId, d && d.trimColorId]).filter(Boolean).map(String))];
    const doorColorMap = new Map<string, { label: string; rate: number }>();
    if (colorIds.length) {
      const cr = await supabase.from("colors").select("id, label, door, door_rate").eq("client_id", clientId).in("id", colorIds);
      for (const r of cr.data ?? []) if (r.door === true) doorColorMap.set(String(r.id), { label: String(r.label || ""), rate: Number(r.door_rate) || 0 });
    }
    // `charge` = the door's CATALOG color_mode is paint/match (customer-chosen color). A
    // fixed-color door stamps its color for the description, but its own price already
    // includes that one color — no rate on top. The mode comes from fixture_items, never
    // the body, so a forged payload can't dodge (or invent) a surcharge.
    const colorBit = (id: unknown, fallbackLabel: unknown, suffix: string, charge: boolean): { text: string | null; rate: number } => {
      const c = id ? doorColorMap.get(String(id)) : undefined;
      const label = c ? c.label : (id && fallbackLabel ? String(fallbackLabel) : null);
      const rate = charge && c ? c.rate : 0;
      return { text: label ? `${label}${suffix}${rate > 0 ? ` ($${rate})` : ""}` : null, rate };
    };
    const dg = new Map<string, { name: string; price: number; qty: number; desc: string; fixtureItemId: string | null }>();
    for (const d of doors) {
      // A FOUND catalog row always wins, its NULL/0 price included (the owner's "unpriced =
      // not charged" contract). The body's snapshot price survives ONLY where there is
      // genuinely no server source: the row is GONE (portal-settings' delete_fixture
      // hard-deletes, with the documented contract that "placed instances on saved designs
      // keep rendering from their own snapshot") or the entry carries no fixtureItemId
      // (legacy payloads predating the catalog schedule). That fallback hands an attacker
      // nothing new — doors[] is client-authored, so a forged-id $1 line is no cheaper
      // than simply omitting the door from the payload.
      const dFid = d && d.fixtureItemId ? String(d.fixtureItemId) : null;
      const dFx = dFid ? fxImg.get(dFid) : undefined;
      const basePrice = dFx !== undefined
        ? (dFx.price != null ? dFx.price : 0)
        : (d && d.price != null ? Number(d.price) : 0);
      // Chosen colors: each adds its flat per-door rate to the line and its name (with the
      // price when it charges) to the description — "Barn Red ($50) · White trim ($25)".
      const chargeColors = dFx !== undefined && (dFx.colorMode === "paint" || dFx.colorMode === "match");
      const mainC = colorBit(d && d.colorId, d && d.colorLabel, "", chargeColors);
      const trimC = colorBit(d && d.trimColorId, d && d.trimColorLabel, " trim", chargeColors);
      const price = basePrice + mainC.rate + trimC.rate;
      if (!(price > 0)) continue;
      const name = (String(d.name || "Door").trim()) || "Door";
      // Spell swing + operation out the same way the floor-plan PDF does (out-swing, right hinge)
      // so the estimate line and the plan read identically.
      const sw = d.swing === "in" ? "in-swing" : d.swing === "out" ? "out-swing" : null;
      const op = d.operation === "slideup" ? "slide up" : d.operation === "double" ? "double" : d.operation === "right" ? "right hinge" : d.operation === "left" ? "left hinge" : null;
      const desc = [d.widthIn && d.heightIn ? `${fmtFtIn(d.widthIn)}×${fmtFtIn(d.heightIn)}` : null, sw, op, mainC.text, trimC.text, d.wall ? `${d.wall} wall` : null].filter(Boolean).join(" · ");
      const key = `${name}|${price}|${mainC.text || ""}|${trimC.text || ""}`;
      const g = dg.get(key) || { name, price, qty: 0, desc, fixtureItemId: (d.fixtureItemId || null) };
      g.qty++; dg.set(key, g);
    }
    for (const g of dg.values()) {
      // Fixtures-catalog doors (2026-07-30) — their own line kind: they are neither a
      // layout_item (no layout_item_pricing row) nor a custom option (catalog-priced).
      // Net the size-included qty (building_size_inclusions keyed by the fixture id) — the
      // first N are covered by the base price (shown as a $0 "(included)" line), extras are
      // charged. The pool is shared across this fixture's color groups (see takeFxIncluded).
      const inc = takeFxIncluded(g.fixtureItemId ? String(g.fixtureItemId) : null, g.qty);
      const chargeable = Math.max(0, g.qty - inc);
      const im = g.fixtureItemId ? fxImg.get(String(g.fixtureItemId)) : null;
      const atts = (im && im.show && im.url) ? imgAttachments(im.url) : [];
      const included = inc > 0 && chargeable <= 0;
      targetItems.push(tagLine({
        name: included ? g.name + " (included)" : g.name, qty: included ? g.qty : chargeable, amount: included ? 0 : g.price,
        priceId: "", productId: "", attachments: atts,
        currency: "USD", type: "one_time", description: g.desc || "",
      }, { kind: "door", nonTaxable: g.fixtureItemId ? fixtureTaxable.get(String(g.fixtureItemId)) === false : false }));
    }
  }

  if (Array.isArray(summary.workbenches) && summary.workbenches.length > 0) {
    // ONE aggregated workbench line (total feet), so the inclusion is netted once — matching
    // the designer preview, which also rolls all workbenches into a single row. (Pushing a line
    // per workbench would subtract the included footage from each, under-charging.)
    const totalFt = summary.workbenches.reduce((s: number, wb: any) => s + (Number(wb.lengthFt) || 1), 0);
    const desc = summary.workbenches.map((wb: any) => `${wb.wall ? wb.wall + " wall " : ""}${wb.lengthFt || 1}ft`).join(", ") + " (priced per foot)";
    pushItem(["Workbench/Pegboard", "Workbench", "Pegboard", "Per Foot"], "workbench", desc, { count: summary.workbenches.length, lengthFt: totalFt });
  }
  // Shelves follow the workbench rule exactly: every run of one type summed into ONE lineal_ft
  // line, so a size inclusion nets once rather than once per shelf. Single and double are
  // separate item_keys because they are separate buttons and separate prices to the builder.
  for (const [key, field, names] of [
    ["shelf", "shelves", ["Single Shelf", "Shelf", "Shelving", "Shelves"]],
    ["doubleShelf", "doubleShelves", ["Double Shelf", "Double Shelving", "Shelves"]],
  ] as [string, string, string[]][]) {
    const rows = (summary as Record<string, unknown>)[field];
    if (!Array.isArray(rows) || rows.length === 0) continue;
    const totalShelfFt = rows.reduce((s: number, r: any) => s + (Number(r.lengthFt) || 1), 0);
    const shelfDesc = rows.map((r: any) => `${r.wall ? r.wall + " wall " : ""}${r.lengthFt || 1}ft`).join(", ") + " (priced per foot)";
    pushItem(names, key, shelfDesc, { count: rows.length, lengthFt: totalShelfFt });
  }
  // ── Electrical ─────────────────────────────────────────────────────────────
  // The package first, then the devices. The devices net against the standard counts merged
  // into includedMap above, so a plan holding exactly the standard layout produces three
  // "(included)" $0 lines under the package — which is what the customer should see: the
  // package covers them, and the quote says so item by item.
  if (electricalPkg) {
    const autoOut = Math.max(1, Math.floor(buildingPerimeter / electricalPkg.outletSpacingFt));
    const autoLight = Math.max(1, Math.round(buildingDepthFt / electricalPkg.lightSpacingFt));
    targetItems.push(tagLine({
      name: electricalPkg.label,
      qty: 1,
      amount: electricalPkg.price,
      priceId: "", productId: "", attachments: [], currency: "USD", type: "one_time",
      description: [
        `${autoOut} outlet${autoOut === 1 ? "" : "s"} at ${electricalPkg.outletSpacingFt} ft spacing`,
        `${autoLight} light${autoLight === 1 ? "" : "s"} at ${electricalPkg.lightSpacingFt} ft spacing`,
        "1 switch",
        electricalPkg.includePanel ? `electrical panel included, ${electricalPkg.panelHeightIn}" off the floor` : "no electrical panel",
      ].join(", "),
    }, { kind: "electrical", nonTaxable: electricalPkg.taxable === false }));
  }
  {
    // Counted whether or not the package was taken: without it every device is simply charged,
    // because includedMap holds nothing for them. That is the a-la-carte case and it needs no
    // rule of its own.
    const dev = (summary as Record<string, unknown>).electricalDevices as Record<string, number> | undefined;
    for (const [key, names] of [
      ["outlet", ["Outlet", "Receptacle", "Plug"]],
      ["lightFixture", ["Light", "Light Fixture", "Lighting"]],
      ["lightSwitch", ["Light Switch", "Switch"]],
    ] as [string, string[]][]) {
      const n = Number(dev?.[key]) || 0;
      if (n > 0) pushItem(names, key, "", { count: n });
    }
  }
  // ── The builder's own electrical items ─────────────────────────────────────
  // Priced SERVER-SIDE from electrical_items by id — the body sends counts, never money (the
  // 2026-08-20 audit finding on fixture doors: a snapshot price used to be trusted verbatim).
  //
  // WHICH price applies is decided by whether the package was taken, and a NULL in that column
  // means the item is not offered that way at all. It is deliberately NOT a fallback to the
  // other column: a builder who priced a fan only as a package add-on has not agreed to sell it
  // on its own, and quietly charging the other number would invent a price they never set.
  {
    const rawItems = Array.isArray((summary as Record<string, unknown>).electricalItems)
      ? (summary as Record<string, unknown>).electricalItems as { id?: unknown; qty?: unknown }[]
      : [];
    if (rawItems.length > 0) {
      const wanted = [...new Set(rawItems.map((r) => String(r?.id ?? "")).filter(Boolean))];
      const eiRes = await supabase.from("electrical_items")
        .select("id, name, price_with_package, price_standalone, taxable, active, internal_only")
        .eq("client_id", clientId).in("id", wanted);
      // Refuse rather than silently drop a real charge — the unpriced-size posture.
      if (eiRes.error) {
        return json({ error: "Could not read your electrical items just now. Try resubmitting in a moment." }, 400);
      }
      const byId = new Map(((eiRes.data ?? []) as {
        id: string; name: string; price_with_package: number | null; price_standalone: number | null;
        taxable: boolean | null; active: boolean; internal_only: boolean }[]).map((r) => [String(r.id), r]));
      const hasPkg = electricalPkg != null;
      for (const raw of rawItems) {
        const id = String(raw?.id ?? "");
        const qty = Math.max(0, Math.floor(Number(raw?.qty) || 0));
        if (!id || qty <= 0) continue;
        const ei = byId.get(id);
        if (!ei || !ei.active) {
          return json({ error: "One of the electrical items on this design is no longer in your catalog. Remove it from the layout, or re-add it in the portal under Settings → Options → Electrical." }, 400);
        }
        const price = hasPkg ? ei.price_with_package : ei.price_standalone;
        if (price == null) {
          return json({ error: hasPkg
            ? `"${ei.name}" has no price set for adding to the electrical package. Set one in the portal under Settings → Options → Electrical, then resubmit.`
            : `"${ei.name}" is only sold as part of the electrical package. Add the package to this design, or set a standalone price for it in the portal.` }, 400);
        }
        targetItems.push(tagLine({
          name: ei.name,
          qty,
          amount: Number(price),
          priceId: "", productId: "", attachments: [], currency: "USD", type: "one_time",
          description: hasPkg ? "Added to the electrical package" : "Electrical item",
        }, { kind: "electrical_item", nonTaxable: ei.taxable === false }));
      }
    }
  }
  if (summary.lofts > 0) {
    // qty/amount are derived from the loft's configured method inside pushItem: per-unit (each)
    // uses the loft count, per-area (sqft_option) uses total loft sqft.
    pushItem(["Loft", "Loft Kit", "Loft Storage"], "loft", "", { count: summary.lofts, optionSqft: Number(summary.loftSqft) || 0 });
  }
  // rampCount = total ramps placed (any shape). Kept for the declined-item guard below; the
  // actual line-pricing is done from the ramps[] schedule when present.
  const rampCount = (() => {
    const v = summary.ramp;
    if (typeof v === "number") return v > 0 ? v : 0;
    const s = String(v ?? "").trim().toLowerCase();
    if (s === "yes") return 1;
    const n = parseInt(s, 10);
    return Number.isFinite(n) && n > 0 ? n : 0;
  })();
  // Ramps (2026-08-01). Two shapes, both from the ramps[] schedule:
  //  • CUSTOM ramp — a catalog style (fixtureItemId set): priced server-side from
  //    fixture_items like fixture doors (audit 2026-08-20), grouped by style+price into
  //    one line each, photo attached from fixture_items.
  //  • SIMPLE ramp — the built-in ramp (no fixtureItemId, no price), priced from the
  //    tenant's single ramp price on client_settings: "each" per ramp, or "per_ft" × the
  //    attached door's width (doorWidthFt).
  // Legacy builds that don't send ramps[] fall back to the old layout_item_pricing "ramp" rate.
  if (Array.isArray(ramps) && ramps.length) {
    const fmtFtIn = (inches: unknown): string => { const n = Number(inches); if (!isFinite(n) || n <= 0) return ""; const ft = Math.floor(n / 12), inch = Math.round((n - ft * 12) * 100) / 100; return ft === 0 ? `${inch}"` : inch === 0 ? `${ft}'` : `${ft}'${inch}"`; };
    const sizeStr = (r: any) => (r && r.widthIn && r.heightIn) ? `${fmtFtIn(r.widthIn)}×${fmtFtIn(r.heightIn)}` : "";
    // Classified by fixtureItemId, not by the body's price (audit 2026-08-20): the designer
    // always sets fixtureItemId on a catalog ramp, and classifying on the client's price let
    // a caller send a catalog ramp with price:null and slide it into the settings-priced
    // simple path (free when no simple ramp price is configured). `price != null` is kept in
    // the custom filter only so a legacy id-less custom ramp isn't repriced (or dropped)
    // through the simple path — it falls into the no-server-source snapshot case below.
    const customRamps = ramps.filter((r: any) => r && (r.fixtureItemId || r.price != null));
    const simpleRamps = ramps.filter((r: any) => !(r && (r.fixtureItemId || r.price != null)));
    // --- custom ramps: priced from the tenant's fixture catalog, grouped by style+price ---
    if (customRamps.length) {
      const rampIds = [...new Set(customRamps.map((r: any) => r && r.fixtureItemId).filter(Boolean))];
      const rImg = new Map<string, { url: string | null; show: boolean; price: number | null }>();
      if (rampIds.length) {
        const rr = await supabase.from("fixture_items").select("id, price, image_url, show_image_on_estimate").eq("client_id", clientId).in("id", rampIds);
        for (const r of rr.data ?? []) rImg.set(String(r.id), { url: r.image_url || null, show: r.show_image_on_estimate !== false, price: r.price != null ? Number(r.price) : null });
      }
      const rg = new Map<string, { name: string; price: number; qty: number; desc: string; fixtureItemId: string | null }>();
      for (const r of customRamps) {
        // Same rule as fixture doors above: a FOUND catalog row always wins (NULL/0 price =
        // included, no line); the body's snapshot survives only for a hard-deleted fixture
        // or a legacy id-less entry — genuinely no server source, and no cheaper for an
        // attacker than omitting the ramp from the client-authored payload.
        const rFid = r && r.fixtureItemId ? String(r.fixtureItemId) : null;
        const rFx = rFid ? rImg.get(rFid) : undefined;
        const price = rFx !== undefined
          ? (rFx.price != null ? rFx.price : 0)
          : (r && r.price != null ? Number(r.price) : 0);
        if (!(price > 0)) continue;   // $0 / unpriced = included, no line
        const name = (String(r.name || "Ramp").trim()) || "Ramp";
        const desc = [sizeStr(r), r.wall ? `${r.wall} wall` : null].filter(Boolean).join(" · ");
        const key = `${name}|${price}`;
        const g = rg.get(key) || { name, price, qty: 0, desc, fixtureItemId: (r.fixtureItemId || null) };
        g.qty++; rg.set(key, g);
      }
      for (const g of rg.values()) {
        // The SHARED pool (takeFxIncluded), not a per-group read of includedMap — the same
        // rule the fixture doors and windows follow. The ramp group key is name|price and the
        // name comes from the body, so one fixture id can span several groups (two ramps of
        // one style under different names, or a catalog style renamed between placements) and
        // a per-group read handed every group the whole inclusion: a $400 ramp given away per
        // duplicate, while the designer's preview netted it once (audit 2026-08-28).
        const inc = takeFxIncluded(g.fixtureItemId ? String(g.fixtureItemId) : null, g.qty);
        const chargeable = Math.max(0, g.qty - inc);
        const included = inc > 0 && chargeable <= 0;
        const im = g.fixtureItemId ? rImg.get(String(g.fixtureItemId)) : null;
        targetItems.push(tagLine({
          name: included ? g.name + " (included)" : g.name, qty: included ? g.qty : chargeable, amount: included ? 0 : g.price,
          priceId: "", productId: "", attachments: (im && im.show && im.url) ? imgAttachments(im.url) : [],
          currency: "USD", type: "one_time", description: g.desc || "",
        }, { kind: "ramp", nonTaxable: g.fixtureItemId ? fixtureTaxable.get(String(g.fixtureItemId)) === false : false }));
      }
    }
    // --- simple ramps: priced from the tenant's single ramp price ---
    if (simpleRamps.length) {
      const rampPrice = Number(settings.ramp_price) || 0;
      const perFt = String(settings.ramp_price_method || "each") === "per_ft";
      const showImg = settings.ramp_show_image !== false;
      const atts = (showImg && settings.ramp_image_url) ? imgAttachments(settings.ramp_image_url) : [];
      if (rampPrice > 0) {
        if (perFt) {
          let totalFt = 0;
          for (const r of simpleRamps) totalFt += Number(r && r.doorWidthFt) || 0;
          totalFt = Math.round(totalFt * 100) / 100;
          if (totalFt > 0) targetItems.push(tagLine({
            name: "Ramp", qty: totalFt, amount: rampPrice,
            priceId: "", productId: "", attachments: atts,
            currency: "USD", type: "one_time", description: `${simpleRamps.length} ramp${simpleRamps.length > 1 ? "s" : ""} · priced per ft of door width`,
          }, { kind: "ramp", nonTaxable: false }));   // simple ramp: no catalog row, no flag
        } else {
          targetItems.push(tagLine({
            name: "Ramp", qty: simpleRamps.length, amount: rampPrice,
            priceId: "", productId: "", attachments: atts,
            currency: "USD", type: "one_time", description: "",
          }, { kind: "ramp", nonTaxable: false }));   // simple ramp: no catalog row, no flag
        }
      }
    }
  } else if (rampCount > 0) {
    pushItem("Ramp", "ramp", "", { count: rampCount });
  }

  // Catalog windows (Options → Windows): priced server-side from fixture_items by
  // fixtureItemId, like fixture doors (audit 2026-08-20 — the body's snapshot price used to
  // be trusted verbatim). Grouped by style+price into one line, photo attached from
  // fixture_items when the owner opts in. Built-in windows are counted in summary.windows
  // and priced via the layout "window" rate above.
  if (Array.isArray(windows) && windows.length) {
    const fmtFtIn = (inches: unknown): string => { const n = Number(inches); if (!isFinite(n) || n <= 0) return ""; const ft = Math.floor(n / 12), inch = Math.round((n - ft * 12) * 100) / 100; return ft === 0 ? `${inch}"` : inch === 0 ? `${ft}'` : `${ft}'${inch}"`; };
    const winIds = [...new Set(windows.map((w: any) => w && w.fixtureItemId).filter(Boolean))];
    const wImg = new Map<string, { url: string | null; show: boolean; price: number | null }>();
    if (winIds.length) {
      const wr = await supabase.from("fixture_items").select("id, price, image_url, show_image_on_estimate").eq("client_id", clientId).in("id", winIds);
      for (const r of wr.data ?? []) wImg.set(String(r.id), { url: r.image_url || null, show: r.show_image_on_estimate !== false, price: r.price != null ? Number(r.price) : null });
    }
    // Chosen window colors: label + flat per-window rate re-resolved from window_colors by
    // id (never the snapshot) — same trust posture as door colors above.
    const wColorIds = [...new Set(windows.map((w: any) => w && w.colorId).filter(Boolean).map(String))];
    const winColorMap = new Map<string, { label: string; rate: number }>();
    if (wColorIds.length) {
      const wcr = await supabase.from("window_colors").select("id, label, rate").eq("client_id", clientId).in("id", wColorIds);
      for (const r of wcr.data ?? []) winColorMap.set(String(r.id), { label: String(r.label || ""), rate: Number(r.rate) || 0 });
    }
    const wg = new Map<string, { name: string; price: number; qty: number; desc: string; fixtureItemId: string | null }>();
    for (const w of windows) {
      // Same rule as fixture doors above: a FOUND catalog row always wins (NULL/0 price =
      // included, no line); the body's snapshot survives only for a hard-deleted fixture or
      // an id-less entry — genuinely no server source, and no cheaper for an attacker than
      // omitting the window from the client-authored payload.
      const wFid = w && w.fixtureItemId ? String(w.fixtureItemId) : null;
      const wFx = wFid ? wImg.get(wFid) : undefined;
      const basePrice = wFx !== undefined
        ? (wFx.price != null ? wFx.price : 0)
        : (w && w.price != null ? Number(w.price) : 0);
      const wc = (w && w.colorId) ? winColorMap.get(String(w.colorId)) : undefined;
      const colorLabel = wc ? wc.label : (w && w.colorId && w.colorLabel ? String(w.colorLabel) : null);
      const colorRate = wc ? wc.rate : 0;
      const colorText = colorLabel ? `${colorLabel}${colorRate > 0 ? ` ($${colorRate})` : ""}` : null;
      const price = basePrice + colorRate;
      if (!(price > 0)) continue;   // $0 / unpriced = included, no line
      const name = (String(w.name || "Window").trim()) || "Window";
      const desc = [w.widthIn && w.heightIn ? `${fmtFtIn(w.widthIn)}×${fmtFtIn(w.heightIn)}` : null, colorText, w.wall ? `${w.wall} wall` : null].filter(Boolean).join(" · ");
      const key = `${name}|${price}|${colorText || ""}`;
      const g = wg.get(key) || { name, price, qty: 0, desc, fixtureItemId: (w.fixtureItemId || null) };
      g.qty++; wg.set(key, g);
    }
    for (const g of wg.values()) {
      const inc = takeFxIncluded(g.fixtureItemId ? String(g.fixtureItemId) : null, g.qty);
      const chargeable = Math.max(0, g.qty - inc);
      const included = inc > 0 && chargeable <= 0;
      const im = g.fixtureItemId ? wImg.get(String(g.fixtureItemId)) : null;
      targetItems.push(tagLine({
        name: included ? g.name + " (included)" : g.name, qty: included ? g.qty : chargeable, amount: included ? 0 : g.price,
        priceId: "", productId: "", attachments: (im && im.show && im.url) ? imgAttachments(im.url) : [],
        currency: "USD", type: "one_time", description: g.desc || "",
      }, { kind: "window", nonTaxable: g.fixtureItemId ? fixtureTaxable.get(String(g.fixtureItemId)) === false : false }));
    }
  }

  // Rough openings — priced from this tenant's layout_item_pricing "roughOpening" rate (each
  // owner can charge their own price; no hardcoded amount). One line per placed RO at that
  // rate, with the dimensions in the description. If no rate is configured, the line is $0.
  //
  // qty is CLAMPED to a whole positive count (audit 2026-08-28). It was the last body-supplied
  // multiplier on this endpoint still taken verbatim — doors/windows are counted server-side
  // from their arrays, customOptions runs Math.abs, discounts/deliveryFee are staff-gated by
  // 2c — so an anon caller could POST qty:-100 and turn this line into a $15,000 CREDIT that
  // dragged a $12,000 quote to $0.00 on the PDF, the customer email, the GHL opportunity and
  // the estimate_lines snapshot QuickBooks invoices verbatim. The designer only ever sends 1.
  if (Array.isArray(roughOpenings)) {
    const roRate = layoutRates.get("roughOpening")?.rate || 0;
    const roQty = (v: unknown): number => { const n = Math.floor(Number(v)); return Number.isFinite(n) && n > 0 ? n : 1; };
    roughOpenings.forEach((ro: any) => {
      targetItems.push(tagLine({
        name: ro.name || "Rough Opening",
        qty: roQty(ro.qty),
        amount: roRate,
        priceId: "",
        productId: "",
        attachments: [],
        currency: "USD",
        type: "one_time",
        description: ro.dimensions ? String(ro.dimensions) : "",
      }, { kind: "layout_item", itemKey: "roughOpening", nonTaxable: layoutTaxable.get("roughOpening") === false }));
    });
  }

  // Custom options are POSITIVE-ONLY add-on line items (name = title; blank description avoids a
  // duplicate subtitle). A reduction is NOT a custom option — it goes through the "+ Add Discount"
  // rows below (GHL discount total). A negative amount here is ignored so nothing silently bakes
  // into the building; only declined included items adjust the building price.
  if (Array.isArray(allowedCustomOptions)) {
    allowedCustomOptions.filter((co: any) => co.name && String(co.name).trim()).forEach((co: any) => {
      const name = String(co.name).trim();
      const rawAmt = co.amount ? Number(co.amount) || 0 : 0;
      if (rawAmt < 0) return;   // reductions use the Discount button, not custom options
      const qty = co.qty ? Math.abs(Number(co.qty)) || 1 : 1;
      targetItems.push(tagLine({
        name, qty, amount: rawAmt,
        priceId: "", productId: "", attachments: [],
        currency: "USD", type: "one_time", description: "",
        // Typed by the rep, so there is no catalog row to carry a flag — the choice rides on
        // the option itself, the same way a discount row carries its own. Absent = taxable.
      }, { kind: "custom_option", nonTaxable: co?.taxable === false }));
    });
  }

  // Declined included items — the customer opted out of an item the building normally includes,
  // so credit its catalog value: the size's included QUANTITY (building_size_inclusions.qty,
  // populated by the pricing CSV's quantity cells — loft = sq ft, doors = count) times the
  // owner's layout_item_pricing rate, resolved per pricing_method exactly like pushItem. The
  // credit is folded into the building line (bakedCredit) and itemized in the building
  // description — same as negative custom options. Items with no rate (0) are skipped.
  if (Array.isArray(declinedItems) && declinedItems.length) {
    // A placed item is KEPT (charged/netted above), so it is never also credited — this guards
    // the stray place+decline of the same item (which would otherwise go uncharged AND credited).
    const placedKeys = new Set<string>();
    if (summary.singleDoors > 0) placedKeys.add("singleDoor");
    if (summary.doubleDoors > 0) placedKeys.add("doubleDoor");
    if (summary.windows > 0) placedKeys.add("window");
    if (summary.lofts > 0) placedKeys.add("loft");
    if (Array.isArray(summary.workbenches) && summary.workbenches.length > 0) placedKeys.add("workbench");
    if (Array.isArray(summary.shelves) && summary.shelves.length > 0) placedKeys.add("shelf");
    if (Array.isArray(summary.doubleShelves) && summary.doubleShelves.length > 0) placedKeys.add("doubleShelf");
    if (rampCount > 0) placedKeys.add("ramp");
    if (Array.isArray(roughOpenings) && roughOpenings.length > 0) placedKeys.add("roughOpening");
    // A placed catalog fixture (its id in doors/windows/ramps) is kept, not credited.
    for (const d of (Array.isArray(doors) ? doors : [])) if (d?.fixtureItemId) placedKeys.add(String(d.fixtureItemId));
    for (const w of (Array.isArray(windows) ? windows : [])) if (w?.fixtureItemId) placedKeys.add(String(w.fixtureItemId));
    // No price condition on ramps (audit 2026-08-20): a catalog ramp is now server-priced by
    // its fixtureItemId regardless of the body's price, so any id-carrying ramp is placed =
    // kept — otherwise a place+decline with price:null would be charged AND credited.
    for (const r of (Array.isArray(ramps) ? ramps : [])) if (r?.fixtureItemId) placedKeys.add(String(r.fixtureItemId));
    // Declined catalog fixtures aren't in layout_item_pricing — credit the fixture's own price ×
    // included qty. Look up prices for any declined fixture id (a UUID key, not a layout key).
    const declFxPrice = new Map<string, number>();
    const declFxIds = [...new Set(declinedItems.map((x: any) => String(x?.key ?? "").trim())
      .filter((k: string) => k && !placedKeys.has(k) && !layoutRates.has(k)))];
    if (declFxIds.length) {
      const fr = await supabase.from("fixture_items").select("id, price").eq("client_id", clientId).in("id", declFxIds);
      for (const r of fr.data ?? []) if (r.price != null) declFxPrice.set(String(r.id), Number(r.price));
    }
    for (const d of declinedItems) {
      const key = String(d?.key ?? "").trim();
      if (!key) continue;
      if (placedKeys.has(key)) continue;   // placed = kept, not a decline → no credit
      if (declFxPrice.has(key)) {
        const q = includedMap.get(key) || 0;
        if (q <= 0) continue;
        const credit = Math.round(declFxPrice.get(key)! * q * 100) / 100;
        if (credit <= 0) continue;
        bakedCredit += credit;
        creditNotes.push(`${d?.label || "Item"} declined (−$${credit.toFixed(2)})`);
        continue;
      }
      const lp = layoutRates.get(key);
      const rate = lp?.rate || 0;
      if (rate <= 0) continue;
      const method = lp?.method || "each";
      // Credit the included quantity for this size. pct_estimate_total can't be resolved before
      // the subtotal exists, so it keeps a flat credit — qty clamped to 1 so % isn't scaled by
      // sq ft.
      // The default is 0, NOT 1, and must match the charge path's `includedMap.get(itemKey) || 0`
      // above: includedMap only holds rows the size actually includes, and legacy rows are already
      // floored at 1 when it is built. So a MISSING key means the size includes none of this item
      // — there is nothing in the base price to give back, and defaulting to 1 invented a credit
      // for it. That is reachable whenever the designer's includedItemKeys snapshot goes stale
      // (an owner removes an inclusion while a shopper has the page open), which would under-price
      // the emailed quote. A zero-qty credit is skipped below, exactly like a zero rate.
      const qty = method === "pct_estimate_total" ? 1 : (includedMap.get(key) || 0);
      if (qty <= 0) continue;
      // Per-unit value mirrors pushItem's amount for each method, rounded to cents so the
      // printed "qty × unit = credit" math is exact and the summed discount stays sub-cent-free.
      let unitValue = rate, unitLabel = "";
      switch (method) {
        case "sqft_option":        unitLabel = " sq ft"; break;
        case "lineal_ft":          unitLabel = " ft"; break;
        case "sqft_building":      unitValue = rate * buildingArea; break;
        case "perimeter_building": unitValue = rate * buildingPerimeter; break;
        case "pct_building_price": unitValue = (rate / 100) * buildingPrice; break;
        default:                   break; // each / sqft_option / lineal_ft / pct_estimate_total: rate as-is
      }
      unitValue = Math.round(unitValue * 100) / 100;
      const credit = Math.round(unitValue * qty * 100) / 100;
      if (credit <= 0) continue;
      bakedCredit += credit;
      creditNotes.push(`${d?.label || key} declined (−$${credit.toFixed(2)})`);
    }
  }

  // Finalize the building line: subtract the DECLINED-item credits from its amount (so the taxable
  // base drops by the full credit) and itemize them in the DESCRIPTION — original price first, then
  // one line per declined item (no math). With no declines the description stays empty (size is in
  // the name). If credits exceed the building price (rare), zero the line and send the leftover as
  // a discount.
  if (bakedCredit > 0) {
    const applied = Math.min(bakedCredit, buildingPrice);
    creditOverflow = Math.round((bakedCredit - applied) * 100) / 100;
    buildingLine.amount = Math.round((buildingPrice - applied) * 100) / 100;
    // GHL renders the line description as HTML and collapses plain-text "\n" into one paragraph
    // (same as termsNotes below), so escape each line and join with <br> to keep the requested
    // one-per-line layout: original price first, then one line per declined item.
    const escLine = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
    buildingLine.description = [`Original building price: $${buildingPrice.toFixed(2)}`, ...creditNotes]
      .map(escLine).join("<br>");
  }

  // "+ Add Discount" rows — a reduction with a reason. Each shows as a $0 line naming it (so the
  // reason is visible on the estimate) and its amount goes into GHL's invoice discount total below
  // (which prorates across lines, i.e. it reduces tax proportionally). Discounts do NOT touch the
  // building line. allowedDiscounts, not the raw body field: step 2c empties it for callers who
  // aren't verified tenant staff (audit 2026-08-20).
  if (allowedDiscounts.length) {
    allowedDiscounts.forEach((d: any) => {
      const amt = Math.round(Math.abs(Number(d?.amount) || 0) * 100) / 100;
      if (amt <= 0) return;
      discountTotal += amt;
      const desc = String(d?.description ?? "").trim();
      // Absent reads as TAXABLE — the designer's default for a new row, and the direction that
      // never quietly removes money from the tax base.
      ssDiscountRows.push({ description: desc, amount: amt, taxable: d?.taxable !== false });
      // Display-only $0 marker; the money moves in the invoice-level discount, which the
      // provenance records once as a synthetic top-level entry — so this line is skipped.
      targetItems.push(tagLine({
        name: desc ? `Discount — ${desc}` : "Discount",
        qty: 1, amount: 0, priceId: "", productId: "", attachments: [],
        currency: "USD", type: "one_time",
        description: `−$${amt.toFixed(2)} (applied as a discount below)`,
      }, { kind: "discount", skip: true }));
    });
  }


  // 7a. Resolve pct_estimate_total add-ons LAST: each is rate% of the subtotal of every OTHER
  // line (building + non-percentage add-ons + custom options + rough openings + any
  // pct_building_price lines, which resolve earlier). Computed off a fixed base so multiple
  // such add-ons don't compound on each other.
  if (deferredPctLines.length > 0) {
    const baseSubtotal = targetItems.reduce(
      (s, it) => s + (deferredPctLines.some((d) => d.item === it) ? 0 : (Number(it.qty) || 0) * (Number(it.amount) || 0)),
      0,
    );
    for (const d of deferredPctLines) d.item.amount = (d.rate / 100) * baseSubtotal;
  }

  // 7a-ii. Delivery fee — added LAST (after the pct_estimate_total base is computed, so a
  // percentage add-on never applies to delivery). Marked NON-TAXABLE the way GHL actually
  // supports it: with automaticTaxesEnabled the tax engine taxes every line by its tax
  // CATEGORY and IGNORES a per-line `taxes` array — so the old `taxes: []` did nothing and
  // delivery was still taxed. Assigning the line GHL's global "Non-Taxable Product" category
  // (code NT) is the documented way to exempt a single line while other lines stay taxable.
  // Category id is a GoHighLevel-global value (not per-account) per GHL's "Automatic Tax
  // Category IDs and Names" support doc. Amount is the designer's optional delivery-fee field —
  // via allowedDeliveryFee, which step 2c zeroes for callers who aren't verified tenant staff
  // (audit 2026-08-20); omitted entirely when 0/blank.
  const deliveryAmt = allowedDeliveryFee;
  if (deliveryAmt > 0) {
    targetItems.push(tagLine({
      name: "Delivery",
      qty: 1,
      amount: deliveryAmt,
      priceId: "",
      productId: "",
      attachments: [],
      currency: "USD",
      type: "one_time",
      description: "Delivery fee (non-taxable)",
      automaticTaxCategoryId: "6852749d6e0bd3b3466d14b6",   // GHL "Non-Taxable Product" (NT)
    }, { kind: "delivery", nonTaxable: !ssTaxDelivery }));
  }

  // 7b. Opportunity link/create. Pick the most-recently-updated opp for this contact and
  // refresh its name/value/stage; if it's won we leave it alone and create a new one
  // (won deals are closed shed sales — a fresh quote is a new pursuit). If it's lost we
  // update it back to status "open". Failures here are non-fatal — the estimate still
  // goes out.
  const oppName = `${styleLabel} ${size}`.trim();
  // Invoice-level discount = the "+ Add Discount" rows + any declined-credit overflow. Clamp it to
  // the positive line subtotal: a discount larger than the whole order would drive the net total
  // negative and GHL rejects the estimate ("amount must not be less than 0").
  const lineSubtotal = targetItems.reduce((s, it) => s + (Number(it.qty) || 0) * (Number(it.amount) || 0), 0);
  let totalDiscount = Math.round((discountTotal + creditOverflow) * 100) / 100;
  // The declined-item credit overflow is not a rep-chosen discount and has no taxability of its
  // own: it is money coming off the BUILDING (the credits that would not fit inside the building
  // line), so it follows the building's flag rather than defaulting to taxable.
  if (creditOverflow > 0) {
    ssDiscountRows.push({
      description: "Declined included items",
      amount: Math.round(creditOverflow * 100) / 100,
      taxable: styleTaxable,
    });
  }
  if (totalDiscount > lineSubtotal) totalDiscount = Math.round(lineSubtotal * 100) / 100;
  // Declined credits are already baked into the building line amount; subtract the invoice
  // discount so the opportunity value matches the estimate total.
  const oppValue = Math.max(0, lineSubtotal - totalDiscount);
  let opportunityId: string | null = existingDesign.ghl_opportunity_id || null;
  if (contactId) {
    try {
      const sr = await fetch(
        `https://services.leadconnectorhq.com/opportunities/search?location_id=${encodeURIComponent(locationId)}&contact_id=${encodeURIComponent(contactId)}`,
        { headers: ghlHeaders }
      );
      let mostRecent: any = null;
      if (sr.ok) {
        const sd = await sr.json();
        const opps: any[] = Array.isArray(sd?.opportunities) ? sd.opportunities : [];
        if (opps.length > 0) {
          mostRecent = opps.slice().sort((a, b) => {
            const at = new Date(a.updatedAt || a.dateUpdated || a.createdAt || 0).getTime();
            const bt = new Date(b.updatedAt || b.dateUpdated || b.createdAt || 0).getTime();
            return bt - at;
          })[0];
        }
      } else {
        console.warn("Opportunity search failed:", sr.status, await sr.text());
      }

      const foundStatus = mostRecent ? String(mostRecent.status || "").toLowerCase() : null;
      const skipUpdateBecauseWon = foundStatus === "won";

      if (mostRecent && !skipUpdateBecauseWon) {
        const updateBody: any = { name: oppName, monetaryValue: oppValue };
        if (pipelineId) updateBody.pipelineId = pipelineId;
        if (sendQuoteStageId) updateBody.pipelineStageId = sendQuoteStageId;
        if (foundStatus === "lost") updateBody.status = "open";
        const ur = await fetch(
          `https://services.leadconnectorhq.com/opportunities/${mostRecent.id}`,
          { method: "PUT", headers: ghlHeaders, body: JSON.stringify(updateBody) }
        );
        if (ur.ok) {
          opportunityId = mostRecent.id;
        } else {
          console.warn("Opportunity update failed:", ur.status, await ur.text());
          opportunityId = mostRecent.id; // still link the estimate to it
        }
      } else if (pipelineId && sendQuoteStageId) {
        // No opp found, OR most-recent is won → create a fresh opportunity
        const cr = await fetch(
          `https://services.leadconnectorhq.com/opportunities/`,
          {
            method: "POST",
            headers: ghlHeaders,
            body: JSON.stringify({
              pipelineId,
              locationId,
              name: oppName,
              pipelineStageId: sendQuoteStageId,
              status: "open",
              contactId,
              monetaryValue: oppValue,
            }),
          }
        );
        if (cr.ok) {
          const cd = await cr.json();
          opportunityId = cd?.opportunity?.id || cd?.id || null;
        } else {
          console.warn("Opportunity create failed:", cr.status, await cr.text());
        }
      } else {
        console.warn("No pipeline/stage configured for client; skipping opportunity create.");
      }
    } catch (e) {
      console.warn("Opportunity link error:", (e as Error).message);
    }
  }

  // 8. Estimate payload — issue/expiry dates.
  // GHL validates issueDate against the LOCATION's clock and rejects anything "in the
  // future" (code estimate_date_invalid). A date-only value is read at 00:00 in the
  // location's timezone, so for locations west of UTC an early-UTC submission could push
  // "today" into the future. Anchor the issue date 12h behind UTC now: that's <= the
  // current local date in every real timezone (UTC-12..UTC+14), so it's never in the
  // future, while still reading as "today" during normal business hours.
  const fmt = (d: Date) => `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}`;
  const issueAnchor = new Date(Date.now() - 12 * 60 * 60 * 1000);
  const today = fmt(issueAnchor);
  const exp = new Date(issueAnchor.getTime() + 30 * 24 * 60 * 60 * 1000);
  const expiryFormatted = fmt(exp);

  let formattedPhone = "";
  if (contact?.phone) {
    let digitsOnly = String(contact.phone).replace(/\D/g, "");
    if (digitsOnly.length === 10) digitsOnly = "1" + digitsOnly;
    if (digitsOnly.length > 0) formattedPhone = "+" + digitsOnly;
  }

  // The browser uploads a single-page letter PDF of the floor plan to Storage and passes
  // its public URL here as `imageUrl` (the column is still named image_url for legacy reasons).
  // Only attach a URL that points at THIS tenant's floor-plans prefix — never a caller-supplied
  // external URL — so an attacker can't graft arbitrary links onto a tenant's branded estimate.
  const expectedPdfPrefix = `${supabaseUrl}/storage/v1/object/public/floor-plans/${clientId}/`;
  const estimateAttachments: any[] = [];
  if (imageUrl && String(imageUrl).startsWith(expectedPdfPrefix)) {
    estimateAttachments.push({
      id: designId,
      name: `${designId}.pdf`,
      url: imageUrl,
      type: "application/pdf",
      size: 15000,
    });
    // Also surface the floor-plan PDF as the FIRST line of the building description — a clickable
    // link right on the line item, not just an attachment. Reuses the tenant-prefix guard above, so
    // only this tenant's own validated storage URL is embedded (never a caller-supplied link). GHL
    // renders the description as HTML; if it keeps the <a> the link is clickable, otherwise the URL
    // is at least visible/copyable.
    const pdfLink = `<a href="${imageUrl}" target="_blank" rel="noopener noreferrer">View floor plan (PDF)</a>`;
    buildingLine.description = buildingLine.description ? `${pdfLink}<br>${buildingLine.description}` : pdfLink;
  }

  const firstName = contact?.name ? String(contact.name).split(" ")[0] : "Customer";
  const estimateName = `${firstName} - ${styleLabel} ${size}`.trim();
  // Collision-resistant invoice sequence: low 8 digits of the epoch-ms clock
  // (unique within any ~28h window) + 2 random digits to cover two submissions
  // landing in the same millisecond. Replaces a plain 5-digit random, which by
  // the birthday bound collided after only a few hundred estimates.
  const uniqueSequence = (Date.now() % 100_000_000) * 100 + Math.floor(Math.random() * 100);

  // GHL renders termsNotes as HTML, which collapses the plain-text line breaks the owner
  // typed in their quote_terms into a single paragraph. Escape HTML, then convert newlines
  // to <br> so the terms display with the same line/paragraph structure as saved in the portal.
  const termsNotesHtml = quoteTerms
    ? quoteTerms.replace(/\r\n/g, "\n")
        .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
        .replace(/\n/g, "<br>")
    : "";

  const finalPayload: any = {
    altId: dynamicLocationId,
    userId: dynamicUserId,
    altType: "location",
    name: estimateName,
    title: "ESTIMATE",
    invoiceNumberPrefix: "EST-",
    estimateNumberPrefix: "EST-",
    invoiceNumber: (existingEstimateId && existingDesign.ghl_estimate_number) ? String(existingDesign.ghl_estimate_number) : uniqueSequence.toString(),
    currency: "USD",
    issueDate: today,
    expiryDate: expiryFormatted,
    // Terms & Conditions: always populate the estimate's Terms & Notes from the tenant's
    // quote_terms (client_settings). GHL's field is `termsNotes` — the old `terms` key was
    // silently ignored, so quote terms never appeared on the estimate.
    termsNotes: termsNotesHtml,
    businessDetails: {
      name: businessName,
      ...(businessPhone ? { phoneNo: businessPhone } : {}),
      ...(businessWebsite ? { website: businessWebsite } : {}),
      ...(businessAddress ? { address: businessAddress } : {}),
      ...(businessLogoUrl ? { logoUrl: businessLogoUrl } : {}),
    },
    contactDetails: {
      name: contact?.name || "Unknown",
      email: contact?.email || "",
      phoneNo: formattedPhone,
      ...(estimateAddress ? { address: estimateAddress } : {}),
      ...(contactId ? { id: String(contactId) } : {}),
    },
    // GHL invoice discount = the "+ Add Discount" rows + any declined-credit overflow (clamped
    // above). Declined-item credits themselves are baked into the building line, not here.
    discount: totalDiscount > 0
      ? { value: totalDiscount, type: "fixed" }
      : { value: 0, type: "percentage" },
    frequencySettings: { enabled: false },
    // Default the GHL "Enable Tax Automatically" toggle to ON. Reps can still flip it
    // off per-estimate inside GHL (this only sets the initial state). Requires that the
    // GHL location has at least one tax rate configured under Settings → Taxes,
    // otherwise the toggle stays disabled in the UI regardless of this flag. Tax
    // calculation also requires the contact have country/state/postalCode populated;
    // see the address handling above.
    automaticTaxesEnabled: true,
    items: targetItems,
    attachments: estimateAttachments,
    liveMode: true,
    ...(contactId ? { contactId: String(contactId) } : {}),
    ...(opportunityId ? { opportunityId: String(opportunityId) } : {}),
  };

  // Line provenance snapshot (persisted as designs.estimate_lines at step 11).
  //
  // Serialized after pct_estimate_total resolution, credit baking, and the discount clamp
  // (all complete before step 8) so every amount is the FINAL number that went to GHL. The
  // style id is stored once at the top level (every building/layout line shares it) and the
  // invoice-level discount as one synthetic entry, since it is not a line in targetItems.
  // Built BEFORE step 9 (moved up from between 9 and 10 on 2026-08-21) because BOTH send
  // paths render their document from this same snapshot — the own-domain (Resend) path's
  // formal estimate PDF, and the SS-mode quote immediately below, which never reaches step 9
  // at all. Nothing in it depends on the GHL response: every input (targetItems, lineProv,
  // totalDiscount, styleRowId) is final by step 8. Same object, same amounts, so the emailed
  // document and the persisted books lines can never disagree.
  const estimateLines = {
    version: 1,
    styleId: styleRowId,
    discount: totalDiscount > 0 ? totalDiscount : 0,
    // Per-discount taxability, SS mode only (migration 148). `discount` above stays the single
    // clamped number every existing reader expects; this is the breakdown the two-pool totals
    // block is built from. Rows are UNCLAMPED — subtotalsFromSnapshot clamps each pool at >= 0
    // independently, which is the behaviour that stops an over-discount on one pool from eating
    // into the other.
    ...(invoiceInGhl ? {} : {
      discounts: {
        taxable: round2(ssDiscountRows.filter((r) => r.taxable).reduce((a, r) => a + r.amount, 0)),
        nonTaxable: round2(ssDiscountRows.filter((r) => !r.taxable).reduce((a, r) => a + r.amount, 0)),
        rows: ssDiscountRows,
      },
    }),
    lines: targetItems
      .filter((li) => !lineProv.get(li)?.skip)
      .map((li) => {
        const p = lineProv.get(li);
        return {
          kind: p?.kind ?? "fallback",
          itemKey: p?.itemKey ?? "",
          name: String(li.name ?? ""),
          // The GHL line's description is where the specifics live (paint colors, roof
          // type/color, ramp sizing, RO dimensions) — under the simplified category-item
          // model the QuickBooks item is a broad category, so this text is what makes the
          // books line readable. Capped: it feeds a 4000-char QBO Description, not storage.
          desc: String(li.description ?? "").trim().slice(0, 1000),
          qty: Number(li.qty) || 0,
          amount: Number(li.amount) || 0,
          nonTaxable: !!p?.nonTaxable,
        };
      }),
  };

  // ── 9-ALT. StructureStudio issues the quote (client_settings.invoice_in_ghl = false) ──
  //
  // Everything above still ran: the contact was upserted into the CRM and the opportunity was
  // created/moved per the tenant's stage mapping (Carolyn 2026-08-21 — "Contacts are still
  // created in GHL and Opportunities are placed per the settings"). What this branch replaces
  // is only the PAPERWORK: no GHL estimate object is created, and GHL does not email anyone.
  //
  // It returns, so steps 9/10/11 below are the untouched GHL path — no reindentation, no new
  // conditionals threaded through the money path. Junior Barns and every other tenant on
  // invoice_in_ghl = true reach this line and walk straight past it.
  if (!invoiceInGhl) {
    // The number is allocated ONCE per design and reused on every resubmit — the same promise
    // the GHL path keeps by PUTting the same estimate id rather than creating a second one. A
    // customer who receives a revised quote must not see the number change under them.
    let ssQuoteNumber: string | null = existingDesign.ss_quote_number || null;
    if (!ssQuoteNumber) {
      const { data: allocated, error: allocErr } = await supabase
        .rpc("allocate_ss_quote_number", { p_client_id: clientId });
      if (allocErr) {
        return json({ error: `Could not allocate a quote number: ${allocErr.message}` }, 502);
      }
      ssQuoteNumber = allocated ? String(allocated) : null;
    }
    // NULL means the tenant has no starting number. portal-settings refuses to save this
    // combination, so reaching here means the row was edited around the portal — refuse rather
    // than invent a 1, which would collide with the paperwork they already have out.
    if (!ssQuoteNumber) {
      return json({
        error: "This account issues its own quotes but has no starting quote number set. Add one in Settings → CRM Connection → Quotes & Invoices.",
      }, 400);
    }

    // ── Sales tax (migration 148) ───────────────────────────────────────────────────────
    //
    // Resolved HERE, before the document is built and before the change-order delta below, so
    // both the PDF and `totalBefore`/`totalAfter` see the same tax-inclusive figures.
    //
    // A RESUBMIT RE-RESOLVES. That is the live-until-signed rule (Carolyn 2026-08-27): a quote
    // is a live offer, so each time it is issued it is priced at today's rate for today's
    // address. What freezes is the acceptance — customer-accept writes the rate it signed
    // under into design_acceptances, because a later resubmit overwrites this snapshot.
    //
    // The tenant has a rate because portal-settings refuses to turn invoice_in_ghl off without
    // one. Reaching here with NULL means the row was edited around the portal, and quoting an
    // untaxed bill is the one outcome worth refusing over — the same posture the missing quote
    // number takes immediately above.
    if (ssTaxRate == null) {
      return json({
        error: "This account issues its own paperwork but has no sales tax rate set. Add one in Settings → CRM Connection → Quotes & Invoices (enter 0% if you don't collect sales tax).",
      }, 400);
    }
    const taxAddr = addressFrom(contact);
    const resolved = await resolveRate(taxAddr, ssTaxRate);
    {
      const pools = subtotalsFromSnapshot(estimateLines)!;
      const amount = taxOn(pools.taxableBase, resolved.rate);
      // Stamped onto the object that is about to be persisted AND handed to the PDF builder, so
      // the stored figure and the printed one are the same object, not two computations.
      (estimateLines as Record<string, unknown>).tax = {
        rate: resolved.rate,
        amount,
        label: ssTaxLabel,
        taxableSubtotal: pools.taxable,
        nonTaxableSubtotal: pools.nonTaxable,
        taxableBase: pools.taxableBase,
        nonTaxableNet: pools.nonTaxableNet,
        source: resolved.source,
        jurisdiction: resolved.jurisdiction,
        address: { state: taxAddr.state, zip: taxAddr.zip },
        resolvedAt: new Date().toISOString(),
        ...(resolved.reason ? { reason: resolved.reason } : {}),
      };
    }

    // METERED (migration 179) — and ONLY a real Avalara answer costs anything. A `fallback`
    // resolve never left the building: it means Avalara is unconfigured, the address had no
    // state/postcode, or the lookup failed, and billing a tenant for our own outage is the
    // one outcome worth being careful about. Inert until `tax_lookup` is armed.
    //
    // Deliberately AFTER the stamp and deliberately unable to fail the submit: the tax is
    // already on the snapshot and the customer is waiting on their quote. Losing a charge
    // costs cents; losing the quote costs the builder a sale.
    if (resolved.source === "avalara") {
      const meter = await chargeTaxCalculation(supabase, {
        clientId,
        kind: "tax_lookup",
        idem: taxLookupIdem(clientId, String(designId), resolved.rate, resolved.jurisdiction),
        refType: "design",
        refId: String(designId),
        memo: `Sales tax lookup${resolved.jurisdiction ? ` — ${resolved.jurisdiction}` : ""}`,
      });
      if (!meter.charged && meter.reason === "error") {
        logEdgeError({
          fn: "submit-estimate", req, clientId, code: "tax_meter",
          message: `tax_lookup charge failed for ${designId}`,
        }).catch(() => {});
      }
    }

    // The plan PDF the designer just uploaded becomes sheets 2-3 (floor plan, four-sided 3D).
    // Same tenant-prefix guard the GHL attachment path uses — never a caller-supplied external
    // URL, since this one is fetched server-side.
    const planUrl = imageUrl && String(imageUrl).startsWith(expectedPdfPrefix) ? String(imageUrl) : null;
    // The plain-image twins for the order screen's sidebar cards (migration 127) — same
    // prefix guard, persisted below. SS branch only, so the CRM path never writes them.
    const planImg = planImageUrl && String(planImageUrl).startsWith(expectedPdfPrefix) ? String(planImageUrl) : null;
    const view3dImg = view3dImageUrl && String(view3dImageUrl).startsWith(expectedPdfPrefix) ? String(view3dImageUrl) : null;
    const skippedSheets: string[] = [];

    let quotePdfUrl: string | null = null;
    try {
      const pdfBytes = await buildQuotePdf({
        business: {
          name: businessName,
          phone: businessPhone || null,
          website: businessWebsite || null,
          address: businessAddress,
        },
        estimateNumber: ssQuoteNumber,
        dateIso: today,
        lines: estimateLines.lines.map((l) => ({ ...l, desc: deHtml(l.desc) })),
        discount: estimateLines.discount,
        // The two-pool totals block and the per-discount rows (migration 148). Both read the
        // object just stamped above, so the printed figures ARE the persisted ones.
        tax: (estimateLines as Record<string, any>).tax,
        discountRows: (estimateLines as Record<string, any>).discounts?.rows ?? null,
        quoteTerms: quoteTerms || null,
        planPdfUrl: planUrl,
        onSheetSkipped: (r) => skippedSheets.push(r),
      });
      // Service-role upload, so the bucket's anon path-shape policy ({clientId}/SS-….pdf) does
      // not apply — same reasoning as the formal estimate PDF's `-estimate.pdf` sibling.
      // upsert: one quote document per design, replaced on every resubmit.
      const pdfPath = `${clientId}/${designId}-quote.pdf`;
      const up = await supabase.storage.from("floor-plans")
        .upload(pdfPath, pdfBytes, { contentType: "application/pdf", upsert: true });
      if (up.error) {
        console.warn("SS quote PDF upload failed:", up.error.message);
      } else {
        const { data: pub } = supabase.storage.from("floor-plans").getPublicUrl(pdfPath);
        quotePdfUrl = pub?.publicUrl || null;
      }
    } catch (e) {
      // Unlike the plan sheets (which degrade inside buildQuotePdf), a failure HERE means there
      // is no document at all. Still not fatal to the submission: the design, the contact and
      // the opportunity are real and the rep can resubmit. Reported honestly below.
      console.warn("SS quote PDF generation failed:", (e as Error).message);
    }

    // ── THE CHANGE ORDER (migration 126). A resubmit AFTER the customer signed is a change
    // to an agreed order, and it needs their acknowledgment — e-signature or the rep's
    // verbal attestation — before it can be invoiced. The description is GENERATED from the
    // two snapshots (what the customer signed vs what was just built), never typed: a rep
    // summarising their own change is how the acknowledgment drifts from reality. One
    // pending design_edit CO per design, updated in place on every further resubmit so the
    // customer always sees the CUMULATIVE change against what they signed. A resubmit that
    // matches the agreed design (null diff) is not a change order — and it VOIDS a pending
    // designer-raised one, because there is nothing left to acknowledge and an orphan
    // pending CO blocks invoicing forever.
    //
    // THE BASELINE IS `accepted_snapshot`, NOT `estimate_lines` (migration 153; audit finding
    // 16 closed). Everything above and below this block rewrites designs.estimate_lines a few
    // dozen lines from here, so that column can never be "what the customer signed" — read
    // back on the SECOND resubmit it is the FIRST resubmit's unacknowledged revision, and the
    // customer signs a "previous total" they never agreed to while the description shows only
    // the latest increment. `agreedBaseline()` reads the design as of the customer's last
    // ACT OF AGREEMENT: stamped at signing by customer-accept, re-stamped by the
    // change_orders_stamp_agreed trigger on every acknowledged design_edit CO. The diff is
    // therefore genuinely CUMULATIVE — re-derived from the agreed snapshot on every write,
    // which is the only way to get a cumulative description.
    //
    // Four earlier attempts, and why none of them is what this is:
    //   * stamping snapshot_before here — that column is void_change_order's UNDO CONTRACT,
    //     and its restore rewrites 3 of the 9 columns a designer resubmit touches. Nothing
    //     here writes it, so discard behaviour is byte-identical to today's.
    //   * carrying total_before_cents forward off the CO row — the order screen recomputes
    //     that column unconditionally and clobbered whatever we carried. It now computes from
    //     the same agreedBaseline() on the same immutable input, so both writers write the
    //     same number and there is nothing left to collide.
    //   * appending to the description — repeats every sentence whose line changed twice, on
    //     text the customer legally signs. Still generated wholesale, never concatenated.
    //   * treating the pending CO's own baseline as "signed" — after a void there IS no
    //     pending CO, and the next resubmit read the live revision. The baseline is now a
    //     property of the design's agreement, so a void changes nothing about it.
    let changeOrder: { coNo: number | null; description: string; totalBefore: number | null } | null = null;
    if (existingDesign.accepted_at) {
      // THE REVISION GOES ONTO THE DESIGN BEFORE THE CO EXISTS. 153's stamp trigger reads
      // designs.estimate_lines at ACKNOWLEDGMENT, so "what the customer just agreed to" is
      // whatever the row holds by then — and this handler's one persist of that column sits
      // below the change-order block AND below the email, with an anticipated failure path
      // (ss_quote_persist_failed, which still returns ok). A failed persist would therefore
      // leave a signable CO whose total prices lines the design never received, and the
      // trigger would freeze the OLD lines as the agreement. portal-settings' writer has
      // always updated the design first; this makes the invariant true here too.
      //
      // Only on the post-acceptance path, because that is the only place a CO can be raised,
      // and it is a re-write of the same value the persist below sends — idempotent, so a
      // failure here changes nothing that the persist below does not already report durably.
      const { error: preCoErr } = await supabase.from("designs")
        .update({ estimate_lines: estimateLines, updated_at: new Date().toISOString() })
        .eq("short_code", designId);
      if (preCoErr) console.warn("pre-change-order estimate_lines persist failed:", preCoErr.message);
      // Hoisted above the diff: the null-diff arm needs it too.
      const { data: existingCo } = await supabase.from("change_orders")
        .select("id, co_no, version_before, snapshot_before")
        .eq("client_id", clientId).eq("short_code", designId)
        .eq("status", "pending_ack").eq("source", "design_edit")
        .limit(1).maybeSingle();
      const base = agreedBaseline(existingDesign);
      const coDescription = changeOrderDescription(base.lines, estimateLines);
      const oldTotal = totalFromSnapshot(base.lines);
      const newTotal = totalFromSnapshot(estimateLines);
      if (!coDescription) {
        // Resubmitted back to exactly what the customer approved. Under the old baseline this
        // was unreachable (the diff was against the previous revision, so it never came back
        // to nothing); under the agreed baseline it is the ordinary "undo the change" case.
        // Leaving the CO pending would block invoicing forever (portal-settings' send_invoice
        // 409s on a pending CO) while describing a change the design no longer carries.
        // Void only a PURE designer CO: one the order screen has staged onto carries a rep's
        // attribute change that is not ours to discard.
        if (existingCo && !existingCo.snapshot_before) {
          const { error: voidErr } = await supabase.from("change_orders")
            .update({
              status: "void",
              void_reason: "The design was resubmitted back to what the customer approved — nothing left to acknowledge.",
            })
            .eq("id", existingCo.id).eq("status", "pending_ack");
          if (voidErr) console.warn("change order auto-void failed:", voidErr.message);
        }
      } else {
        // The baseline the customer signed: the latest acceptance's design_version. The
        // "after" is the version the browser just saved (save_design runs before us).
        const [{ data: lastAcc }, { data: maxVer }] = await Promise.all([
          supabase.from("design_acceptances").select("design_version")
            .eq("client_id", clientId).eq("short_code", designId)
            .order("accepted_at", { ascending: false }).limit(1).maybeSingle(),
          supabase.from("design_versions").select("version")
            .eq("short_code", designId).order("version", { ascending: false }).limit(1).maybeSingle(),
        ]);
        const coFields = {
          description: coDescription,
          total_before_cents: oldTotal == null ? null : Math.round(oldTotal * 100),
          total_after_cents: newTotal == null ? null : Math.round(newTotal * 100),
          version_before: lastAcc?.design_version ?? null,
          version_after: maxVer?.version ?? null,
        };
        if (existingCo) {
          // Keep the SIGNED baseline (version_before) — the customer acknowledges the total
          // change since their signature, not since the previous unacknowledged revision.
          const { error: coErr } = await supabase.from("change_orders")
            .update({ ...coFields, version_before: existingCo.version_before ?? coFields.version_before })
            .eq("id", existingCo.id);
          if (!coErr) changeOrder = { coNo: existingCo.co_no, description: coDescription, totalBefore: oldTotal };
          else console.warn("change order update failed:", coErr.message);
        } else {
          const { data: coRow, error: coErr } = await supabase.from("change_orders")
            .insert({ client_id: clientId, short_code: designId, source: "design_edit", ...coFields })
            .select("co_no").maybeSingle();
          if (!coErr) changeOrder = { coNo: coRow?.co_no ?? null, description: coDescription, totalBefore: oldTotal };
          else console.warn("change order insert failed:", coErr.message);
        }
      }
    }

    // The email. sendTenantEmail owns the beta redirect, the dark-mode guards and the
    // email_sends ledger, and never throws.
    //
    // The CTA is the CUSTOMER PORTAL (my-quotes), not a GHL page: that is where they view,
    // accept and SIGN the quote (migration 124). The email also carries the printable quote
    // PDF link and the total (Carolyn 2026-08-23 — the printed quote is first-class; the
    // email must hand her future template everything it needs). docWord flips the copy to
    // "quote", her word for SS-issued paperwork.
    //
    // When this resubmit raised a CHANGE ORDER, the customer gets the change-order email
    // INSTEAD — one email describing what changed with a Review & Approve CTA, not a
    // routine "your quote is ready" that buries the thing needing their signature.
    const intendedTo = String(contact?.email || "").trim();
    let emailed = false;
    let emailReason: string | null = null;
    if (intendedTo || redirectToTestInbox) {
      const content = changeOrder
        ? changeOrderEmail({
          businessName,
          logoUrl: businessLogoUrl || null,
          phone: businessPhone || null,
          website: businessWebsite || null,
          quoteNumber: ssQuoteNumber,
          coNo: changeOrder.coNo ?? 0,
          description: changeOrder.description,
          // The figure stamped on the CO, carried on `changeOrder` — NOT recomputed from
          // designs.estimate_lines. Recomputing prints the drifted total in the email while
          // the CO and the customer's quote page show the agreed one (153).
          totalBefore: changeOrder.totalBefore,
          totalAfter: oppValue,
          reviewUrl: myQuotesUrl(clientId, req),
          quoteTerms: quoteTerms || null,
        })
        : estimateEmail({
          templateCopy: settings.email_template_copy,
          businessName,
          logoUrl: businessLogoUrl || null,
          phone: businessPhone || null,
          website: businessWebsite || null,
          estimateNumber: ssQuoteNumber,
          total: oppValue,
          styleLabel,
          sizeLabel: size,
          estimateUrl: myQuotesUrl(clientId, req),
          pdfUrl: planUrl,
          formalPdfUrl: quotePdfUrl,
          quoteTerms: quoteTerms || null,
          docWord: "quote",
        });
      const outcome = await sendTenantEmail(supabase, clientId, {
        kind: changeOrder ? "change_order" : "estimate",
        shortCode: designId,
        to: intendedTo,
        subject: content.subject,
        html: content.html,
        text: content.text,
      });
      emailed = outcome.sent;
      if (!outcome.sent) emailReason = outcome.reason || "failed";
    } else {
      emailReason = "no recipient";
    }

    // Persist. ss_quote_sent_at is stamped ONLY when the customer was actually emailed, so
    // "numbered but never sent" stays visible and recoverable — the same distinction
    // invoice_sends draws between 'created' and 'sent'. There is no GHL estimate id or number
    // to write, and the two GHL ids that DO exist are written exactly as the GHL path does.
    const { error: persistErr } = await supabase
      .from("designs")
      .update({
        ghl_contact_id: contactId,
        ghl_opportunity_id: opportunityId || existingDesign.ghl_opportunity_id || null,
        estimate_lines: estimateLines,
        ss_quote_number: ssQuoteNumber,
        ...(quotePdfUrl ? { ss_quote_pdf_url: quotePdfUrl } : {}),
        ...(planImg ? { plan_image_url: planImg } : {}),
        ...(view3dImg ? { view3d_image_url: view3dImg } : {}),
        // ss_quote_sent_at means the QUOTE email landed; a change-order email is a
        // different document and must not masquerade as the quote having been sent.
        ...(emailed && !changeOrder ? { ss_quote_sent_at: new Date().toISOString() } : {}),
        updated_at: new Date().toISOString(),
      })
      .eq("short_code", designId);
    // A failed persist is worth surfacing: the number has been consumed and the customer may
    // already hold the document, so silence here would leave nothing to reconcile against.
    // Durable log + a warning in the response, not just the console — the runtime console
    // stream is unreliable on this project (see CLAUDE.md), and a silent ok:true leaves the
    // allocated quote number diverged from what the row stores.
    if (persistErr) {
      console.warn("SS quote persist failed:", persistErr.message);
      logEdgeError({
        fn: "submit-estimate",
        req,
        clientId,
        code: "ss_quote_persist_failed",
        message: `SS quote persist failed after issue/email: ${persistErr.message}`,
        context: { designId: String(designId), ssQuoteNumber, emailed },
      }).catch(() => {});
    }

    return json({
      ok: true,
      issuedBy: "structurestudio",
      ...(persistErr
        ? { warning: "The quote was issued, but saving it to the design failed — the stored record may be out of date. The error was logged for support." }
        : {}),
      contactId,
      opportunityId: opportunityId || existingDesign.ghl_opportunity_id || null,
      // No GHL estimate exists in this mode. Reported as null rather than omitted so a caller
      // reading `estimateId` gets an explicit "there isn't one" instead of undefined.
      estimateId: null,
      estimateNumber: ssQuoteNumber,
      quoteNumber: ssQuoteNumber,
      quotePdfUrl,
      quoteEmailed: emailed,
      quoteEmailReason: emailReason,
      // Which sheets the document is missing, and why — the answer to "the customer says the
      // 3D page isn't there".
      sheetsSkipped: skippedSheets,
      updated: Boolean(existingDesign.ss_quote_number),
      // A resubmit after the customer signed raised (or refreshed) a pending change order —
      // the designer surfaces "awaiting the customer's approval" instead of a routine
      // success line.
      ...(changeOrder ? { changeOrder: { coNo: changeOrder.coNo, pending: true } } : {}),
      betaMode: effectiveBetaMode,
      betaRedirected: redirectToTestInbox,
      betaRedirectedTo: redirectToTestInbox ? betaEmail : null,
    });
  }

  // 9. Create or update
  let estimateId: string | null = existingEstimateId;
  let estimateNumber: string | null = null;
  const hadLineImages = targetItems.some((it) => Array.isArray(it.attachments) && it.attachments.length > 0);
  let lineImagesStripped = false;
  // Set when a stale ghl_estimate_id forced a create instead of an update — see below. Kept out
  // of the try so the response can report it honestly as a create rather than an update.
  let recreatedFromStale = false;
  try {
    const url = existingEstimateId
      ? `https://services.leadconnectorhq.com/invoices/estimate/${existingEstimateId}`
      : `https://services.leadconnectorhq.com/invoices/estimate`;
    const method = existingEstimateId ? "PUT" : "POST";
    let r = await fetch(url, { method, headers: ghlHeaders, body: JSON.stringify(finalPayload) });
    // Resilience: the optional per-line product images must never break an estimate. If GHL
    // rejects the payload and we attached line-item images, retry once WITHOUT them so the
    // estimate (and the customer email) still goes out — imageless in the worst case.
    if (!r.ok && hadLineImages) {
      const stripped = { ...finalPayload, items: targetItems.map((it) => ({ ...it, attachments: [] })) };
      const r2 = await fetch(url, { method, headers: ghlHeaders, body: JSON.stringify(stripped) });
      if (r2.ok) { r = r2; lineImagesStripped = true; console.warn("Estimate retried without line-item images (GHL rejected attachments)."); }
    }
    // A stored ghl_estimate_id goes stale in two real, observed ways: staff DELETE the estimate
    // inside GHL while tidying the location (GHL then answers the PUT 404 "Unable to find estimate
    // with the given estimateId"), or the customer ACCEPTS it and GHL refuses further edits with
    // 400 "Estimate is already accepted". Until now either one returned a terminal 502, and since
    // nothing cleared the column, EVERY later resubmit of that design failed identically — the
    // design could never produce a quote again without hand-editing the row. Both shapes are in
    // app_errors against a real tenant. So: fall back to creating a fresh estimate, and let the
    // new id replace the stale one where it is persisted below.
    if (!r.ok && existingEstimateId) {
      const staleBody = await r.text();
      const gone = r.status === 404;
      const locked = r.status === 400 && /already\s*(been\s*)?accepted/i.test(staleBody);
      if (gone || locked) {
        console.warn(`submit-estimate: stale ghl_estimate_id (${r.status}) — creating a fresh estimate instead`);
        // A fresh estimate number, NOT the old one: when the estimate was merely accepted it still
        // exists in GHL, so reusing its number would collide. The deleted case does not care.
        const recreatePayload = { ...finalPayload, invoiceNumber: uniqueSequence.toString() };
        const rc = await fetch(`https://services.leadconnectorhq.com/invoices/estimate`,
          { method: "POST", headers: ghlHeaders, body: JSON.stringify(recreatePayload) });
        if (!rc.ok) {
          return json({ error: `Failed to recreate estimate after a stale id: ${rc.status} ${await rc.text()}` }, 502);
        }
        r = rc;
        recreatedFromStale = true;
      } else {
        return json({ error: `Failed to update estimate: ${r.status} ${staleBody}` }, 502);
      }
    }
    if (!r.ok) {
      return json({ error: `Failed to create estimate: ${r.status} ${await r.text()}` }, 502);
    }
    const d = await r.json();
    estimateId = d?._id || d?.estimate?._id || (recreatedFromStale ? null : existingEstimateId);
    estimateNumber = String(d?.estimateNumber ?? d?.estimate?.estimateNumber ?? d?.invoiceNumber ?? uniqueSequence);
  } catch (e) {
    return json({ error: `Estimate ${existingEstimateId ? "update" : "create"} error: ${(e as Error).message}` }, 502);
  }

  // 10. Send (re-emails on update, per requirements). Routed per the header: tenants with
  //     email_provider='resend' get action:"send_manually" + our own Resend email;
  //     everyone else (and every Resend failure) gets today's GHL action:"email" send.
  //     Recipient is the tenant's test inbox when beta mode is on, otherwise the customer
  //     — see the header for where each path implements that. `betaEmail` was already
  //     validated above, so by here beta mode implies a usable address. We capture the GHL
  //     response (status + body) and return it as `sendDebug` so failures don't hide
  //     behind a generic 200 — the React app or curl caller can inspect what GHL rejected,
  //     `sentTo` says who actually received it, `provider` says which sender delivered it,
  //     and `provider` carries the ledger outcome whenever the own-domain path was attempted.
  let sendDebug: {
    status: number | null;
    ok: boolean;
    body: string;
    sentTo: string[];
    provider: "resend" | "ghl";
    ownDomain?: { sent: boolean; messageId?: string; reason?: string; error?: string };
  } = {
    status: null,
    ok: false,
    body: "send step did not run",
    sentTo: [],
    provider: "ghl",
  };
  try {
    if (estimateId) {
      const hostedUrl = estimateUrl(estimateId);
      const intendedTo = String(contact?.email || "").trim();
      let ownDomainHandled = false;

      // Own-domain path. Routes on the provider flag + a buildable hosted-page link + having
      // somewhere to send (the customer's address, or beta mode's guaranteed test inbox).
      // Deliberately NOT on email_domain_status: sendTenantEmail owns From resolution
      // (verified tenant domain vs the platform domain) and goes dark on its own when
      // neither is usable — that dark verdict lands us on the GHL fallback below.
      if (settings.email_provider === "resend" && hostedUrl && (intendedTo || redirectToTestInbox)) {
        // (a) Flip the estimate to 'sent' in GHL WITHOUT GHL emailing anyone.
        // action:"send_manually", live-verified 2026-08-10: 201, estimateStatus 'sent',
        // no email, idempotent on a repeat call. Same body as the email send otherwise —
        // including userId, which the endpoint REQUIRES (422 "userId is required").
        const manualBody = {
          altId: dynamicLocationId,
          altType: "location",
          userId: dynamicUserId,
          action: "send_manually",
          liveMode: true,
        };
        const mr = await fetch(
          `https://services.leadconnectorhq.com/invoices/estimate/${estimateId}/send`,
          { method: "POST", headers: ghlHeaders, body: JSON.stringify(manualBody) }
        );
        sendDebug.status = mr.status;
        sendDebug.ok = mr.ok;
        sendDebug.body = (await mr.text()).slice(0, 2000); // cap to avoid huge responses

        if (mr.ok) {
          // (b) Formal estimate PDF — BEST-EFFORT, own-domain path only. Any failure here
          // logs and proceeds without the link; a cosmetic document must never block the
          // estimate email.
          let formalPdfUrl: string | null = null;
          try {
            // deHtml is at module scope (see its comment there) — shared with the SS-mode
            // quote so the two documents cannot de-render the same snapshot differently.
            const pdfBytes = await buildFormalEstimatePdf({
              business: {
                name: businessName,
                phone: businessPhone || null,
                website: businessWebsite || null,
                address: businessAddress,
              },
              estimateNumber: estimateNumber || existingDesign.ghl_estimate_number || null,
              dateIso: today,          // same issue date as the GHL estimate (step 8)
              lines: estimateLines.lines.map((l) => ({ ...l, desc: deHtml(l.desc) })),
              discount: estimateLines.discount,
              quoteTerms: quoteTerms || null,
            });
            // Service-role upload: the floor-plans bucket's path-shape RLS policy
            // (`{clientId}/SS-….pdf`) governs the ANON browser upload only — service role
            // bypasses RLS, so the `-estimate.pdf` suffix is fine here. upsert:true keeps
            // one formal PDF per design, replaced on every resubmit.
            const pdfPath = `${clientId}/${designId}-estimate.pdf`;
            const up = await supabase.storage.from("floor-plans")
              .upload(pdfPath, pdfBytes, { contentType: "application/pdf", upsert: true });
            if (up.error) {
              console.warn("formal estimate PDF upload failed:", up.error.message);
            } else {
              const { data: pub } = supabase.storage.from("floor-plans").getPublicUrl(pdfPath);
              formalPdfUrl = pub?.publicUrl || null;
            }
          } catch (e) {
            console.warn("formal estimate PDF generation failed:", (e as Error).message);
          }

          // (c) The branded email. sendTenantEmail handles the beta redirect itself
          // (recording the pre-redirect recipient as intended_email), the dark guards,
          // and the email_sends ledger — and it never throws.
          const content = estimateEmail({
          templateCopy: settings.email_template_copy,
            businessName,
            logoUrl: businessLogoUrl || null,
            phone: businessPhone || null,
            website: businessWebsite || null,
            estimateNumber: estimateNumber || existingDesign.ghl_estimate_number || "",
            total: oppValue,
            styleLabel,
            sizeLabel: size,
            estimateUrl: hostedUrl,
            // Same tenant-prefix guard as the estimate attachment in step 8 — never a
            // caller-supplied external URL in a customer's email.
            pdfUrl: imageUrl && String(imageUrl).startsWith(expectedPdfPrefix) ? String(imageUrl) : null,
            formalPdfUrl,
            quoteTerms: quoteTerms || null,
          });
          const outcome = await sendTenantEmail(supabase, clientId, {
            kind: "estimate",
            shortCode: designId,
            to: intendedTo,
            subject: content.subject,
            html: content.html,
            text: content.text,
          });
          if (outcome.sent) {
            ownDomainHandled = true;
            sendDebug.provider = "resend";
            sendDebug.sentTo = [outcome.to];
            sendDebug.ownDomain = { sent: true, messageId: outcome.messageId };
          } else {
            // not_active or failed → fall through to the GHL email send below. GHL accepts
            // a second send call on an already-'sent' estimate (double-send verified safe
            // 2026-08-10), so the recovery path is today's exact sender. The failed
            // attempt stays inspectable in sendDebug.ownDomain.
            sendDebug.ownDomain = {
              sent: false,
              reason: outcome.reason,
              ...(outcome.error ? { error: outcome.error } : {}),
            };
          }
        } else {
          // send_manually refused → the estimate was never flipped to 'sent'; the GHL
          // email send below both flips and emails, so fall through to it.
          console.warn("Estimate send_manually failed:", mr.status, sendDebug.body);
        }
      }

      if (!ownDomainHandled) {
        // GHL path — byte-identical to the pre-own-domain behavior for 'ghl' tenants.
        // Beta mode redirects to the tenant's own test inbox. Not a filter over the
        // customer's address — a REPLACEMENT, so the customer is never a recipient of a
        // test estimate even if their address is also on the design.
        const recipients = redirectToTestInbox ? [betaEmail] : [contact?.email].filter(Boolean);
        sendDebug.sentTo = recipients;
        const sendBody = {
          altId: dynamicLocationId,
          altType: "location",
          userId: dynamicUserId,
          action: "email",
          liveMode: true,
          sentTo: { email: recipients },
        };
        const r = await fetch(
          `https://services.leadconnectorhq.com/invoices/estimate/${estimateId}/send`,
          { method: "POST", headers: ghlHeaders, body: JSON.stringify(sendBody) }
        );
        sendDebug.status = r.status;
        sendDebug.ok = r.ok;
        sendDebug.body = (await r.text()).slice(0, 2000); // cap to avoid huge responses
        if (!r.ok) console.warn("Estimate send failed:", r.status, sendDebug.body);
        else console.log("Estimate send OK:", r.status, sendDebug.body.slice(0, 200));
      }
    } else {
      sendDebug.body = "no estimateId after create/update";
    }
  } catch (e) {
    sendDebug.body = `send threw: ${(e as Error).message}`;
    console.warn("Estimate send error:", (e as Error).message);
  }

  // 11. Persist GHL IDs + the line provenance snapshot (estimateLines — built just above
  //     step 10, same object; see its comment for the serialization-timing invariants).

  const { error: persistErr } = await supabase
    .from("designs")
    .update({
      ghl_contact_id: contactId,
      ghl_estimate_id: estimateId,
      ghl_estimate_number: estimateNumber || existingDesign.ghl_estimate_number || null,
      ghl_opportunity_id: opportunityId || existingDesign.ghl_opportunity_id || null,
      estimate_lines: estimateLines,
      updated_at: new Date().toISOString(),
    })
    .eq("short_code", designId);
  // A failed persist here is the duplicate-estimate seed: the GHL estimate exists and the
  // email may already be out, but the row never learned its id — so the NEXT resubmit
  // POSTs a brand-new estimate instead of PUTting this one. Durable log + a warning in
  // the response, never a silent ok:true (same treatment as the 9-ALT persist above).
  if (persistErr) {
    console.warn("GHL estimate persist failed:", persistErr.message);
    logEdgeError({
      fn: "submit-estimate",
      req,
      clientId,
      code: "ghl_estimate_persist_failed",
      message: `designs update after GHL estimate create/send failed: ${persistErr.message}`,
      context: { designId: String(designId), estimateId, estimateNumber, recreatedFromStale },
    }).catch(() => {});
  }

  return json({
    ok: true,
    ...(persistErr
      ? { warning: "The estimate was created and sent, but saving its reference to the design failed — resubmitting may create a duplicate estimate. The error was logged for support." }
      : {}),
    contactId,
    estimateId,
    estimateNumber: estimateNumber || existingDesign.ghl_estimate_number || null,
    opportunityId: opportunityId || existingDesign.ghl_opportunity_id || null,
    // Honest about what actually happened: a stale id that forced a create is NOT an update.
    updated: Boolean(existingEstimateId) && !recreatedFromStale,
    recreatedFromStale,
    betaMode: effectiveBetaMode,
    // Where the email actually went. `betaMode` alone used to be pure telemetry; now it
    // has a consequence, so the caller is told the consequence rather than being left to
    // infer it. The designer surfaces this so a tester can see the redirect happened.
    betaRedirected: redirectToTestInbox,
    betaRedirectedTo: redirectToTestInbox ? betaEmail : null,
    lineImagesStripped,
    sendDebug,
  });
}));
