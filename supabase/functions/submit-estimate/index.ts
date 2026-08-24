import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";
import { logEdgeError, withErrorLog } from "../_shared/logError.ts";
import { sendTenantEmail } from "../_shared/emailSend.ts";
import { estimateEmail } from "../_shared/emailTemplates.ts";
import { estimateUrl } from "../_shared/ghlLinks.ts";
import { buildFormalEstimatePdf } from "../_shared/estimatePdf.ts";

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

Deno.serve(withErrorLog("submit-estimate", async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  let payload: any;
  try { payload = await req.json(); }
  catch { return json({ error: "Invalid JSON" }, 400); }

  const { designId, clientId, contact, selections, itemSummary, roughOpenings, customOptions, doors, ramps, windows, imageUrl, betaMode, deliveryFee, declinedItems, discounts } = payload || {};

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
    .select("ghl_location_id, ghl_api_key, ghl_pipeline_id, ghl_stage_send_quote_id, business_name, business_phone, business_website, business_address, business_logo_url, quote_terms, beta_mode, beta_email, ramp_price, ramp_price_method, ramp_image_url, ramp_show_image, email_provider, email_domain_status, email_domain, email_from_local, email_from_name")
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
    .select("client_id, ghl_contact_id, ghl_estimate_id, ghl_estimate_number, ghl_opportunity_id")
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
  let allowedDiscounts: any[] = Array.isArray(discounts) ? discounts : [];
  let allowedDeliveryFee: number = Number(deliveryFee) || 0;
  if (wantsDiscounts || wantsDeliveryFee) {
    let staffCaller = false;
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
  //    must not block an estimate, and userId falls back to the users API.
  let products: any[] = [];
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

  const dynamicLocationId = (products[0]?.locationId) || locationId;

  // 5b. Resolve the GHL userId the estimate is assigned to. GHL's estimate API rejects an
  // empty userId ("userId should not be empty"). Resolution order:
  //   1. products[0].createdBy   — borrow from an existing product (how prod/Junior Barns works)
  //   2. GET /users/?locationId= — first user in the location
  // If both come up empty (e.g. a brand-new GHL location with no products and no assigned
  // users), we fail early with an actionable message instead of GHL's cryptic 422.
  let dynamicUserId = (products[0]?.createdBy) || "";
  if (!dynamicUserId) {
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
  if (!dynamicUserId) {
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
  try {
    const stRes = await supabase.from("building_styles").select("id, key, label, image_url, show_image_on_estimate").eq("client_id", clientId);
    const styleRow = (stRes.data || []).find((r: any) => norm(r.key) === norm(style) || norm(r.label) === norm(style));
    if (styleRow) {
      styleRowId = styleRow.id;
      styleLabel = styleRow.label || style;
      styleImageUrl = styleRow.image_url || null;
      styleShowImage = styleRow.show_image_on_estimate !== false;
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
  targetItems.push(tagLine(buildingLine, { kind: "building" }));

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
      }, { kind: "layout_item", itemKey: itemKey || "" }));
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
    targetItems.push(tagLine(item, { kind: "layout_item", itemKey: itemKey || "" }));
    if (method === "pct_estimate_total") deferredPctLines.push({ item, rate });
  };

  // Price a single color (paint or roof) by its catalog rate + pricing_method — same math as
  // layout add-ons. pct_estimate_total isn't supported on a combined color line (colors realistically
  // use each / pct_building_price / flat), so it falls back to 0.
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
        for (const row of [resolve(selections.paintBodyColor), resolve(selections.paintTrimColor)]) {
          if (row && !seen.has(row.id)) { seen.add(row.id); paintAmount += colorAmount(row); }
        }
      } catch { /* colors lookup failed → still emit the line at $0 */ }
    }
    targetItems.push(tagLine({
      name: "Paint Colors", qty: 1, amount: paintAmount, priceId: "", productId: "",
      attachments: [], currency: "USD", type: "one_time", description: paintDesc,
    }, { kind: "paint" }));
  }

  // ── Line 3: Roof ── shown whenever the tenant offers roofs (the designer then always sends a
  // roofType key, possibly empty). Type + Color in the description; amount is the roof color's rate.
  if (Object.prototype.hasOwnProperty.call(selections, "roofType")) {
    const roofType = String(selections.roofType ?? "").trim();
    const roofColor = String(selections.roofColor ?? "").trim();
    let roofAmount = 0;
    let roofDesc = "No roof selected";
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
        } catch { /* colors lookup failed → still emit the line at $0 */ }
      }
    }
    targetItems.push(tagLine({
      name: "Roof", qty: 1, amount: roofAmount, priceId: "", productId: "",
      attachments: [], currency: "USD", type: "one_time", description: roofDesc,
    }, { kind: "roof" }));
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
    const fxImg = new Map<string, { url: string | null; show: boolean; price: number | null }>();
    if (doorIds.length) {
      const fr = await supabase.from("fixture_items").select("id, price, image_url, show_image_on_estimate").eq("client_id", clientId).in("id", doorIds);
      for (const r of fr.data ?? []) fxImg.set(String(r.id), { url: r.image_url || null, show: r.show_image_on_estimate !== false, price: r.price != null ? Number(r.price) : null });
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
    const colorBit = (id: unknown, fallbackLabel: unknown, suffix: string): { text: string | null; rate: number } => {
      const c = id ? doorColorMap.get(String(id)) : undefined;
      const label = c ? c.label : (id && fallbackLabel ? String(fallbackLabel) : null);
      const rate = c ? c.rate : 0;
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
      const mainC = colorBit(d && d.colorId, d && d.colorLabel, "");
      const trimC = colorBit(d && d.trimColorId, d && d.trimColorLabel, " trim");
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
      }, { kind: "door" }));
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
        const inc = g.fixtureItemId ? (includedMap.get(String(g.fixtureItemId)) || 0) : 0;
        const chargeable = Math.max(0, g.qty - inc);
        const included = inc > 0 && chargeable <= 0;
        const im = g.fixtureItemId ? rImg.get(String(g.fixtureItemId)) : null;
        targetItems.push(tagLine({
          name: included ? g.name + " (included)" : g.name, qty: included ? g.qty : chargeable, amount: included ? 0 : g.price,
          priceId: "", productId: "", attachments: (im && im.show && im.url) ? imgAttachments(im.url) : [],
          currency: "USD", type: "one_time", description: g.desc || "",
        }, { kind: "ramp" }));
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
          }, { kind: "ramp" }));
        } else {
          targetItems.push(tagLine({
            name: "Ramp", qty: simpleRamps.length, amount: rampPrice,
            priceId: "", productId: "", attachments: atts,
            currency: "USD", type: "one_time", description: "",
          }, { kind: "ramp" }));
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
      }, { kind: "window" }));
    }
  }

  // Rough openings — priced from this tenant's layout_item_pricing "roughOpening" rate (each
  // owner can charge their own price; no hardcoded amount). One line per placed RO at that
  // rate, with the dimensions in the description. If no rate is configured, the line is $0.
  if (Array.isArray(roughOpenings)) {
    const roRate = layoutRates.get("roughOpening")?.rate || 0;
    roughOpenings.forEach((ro: any) => {
      targetItems.push(tagLine({
        name: ro.name || "Rough Opening",
        qty: ro.qty || 1,
        amount: roRate,
        priceId: "",
        productId: "",
        attachments: [],
        currency: "USD",
        type: "one_time",
        description: ro.dimensions ? String(ro.dimensions) : "",
      }, { kind: "layout_item", itemKey: "roughOpening" }));
    });
  }

  // Custom options are POSITIVE-ONLY add-on line items (name = title; blank description avoids a
  // duplicate subtitle). A reduction is NOT a custom option — it goes through the "+ Add Discount"
  // rows below (GHL discount total). A negative amount here is ignored so nothing silently bakes
  // into the building; only declined included items adjust the building price.
  if (Array.isArray(customOptions)) {
    customOptions.filter((co: any) => co.name && String(co.name).trim()).forEach((co: any) => {
      const name = String(co.name).trim();
      const rawAmt = co.amount ? Number(co.amount) || 0 : 0;
      if (rawAmt < 0) return;   // reductions use the Discount button, not custom options
      const qty = co.qty ? Math.abs(Number(co.qty)) || 1 : 1;
      targetItems.push(tagLine({
        name, qty, amount: rawAmt,
        priceId: "", productId: "", attachments: [],
        currency: "USD", type: "one_time", description: "",
      }, { kind: "custom_option" }));
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
    }, { kind: "delivery", nonTaxable: true }));
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

  // Line provenance snapshot (persisted as designs.estimate_lines at step 11).
  //
  // Serialized after pct_estimate_total resolution, credit baking, and the discount clamp
  // (all complete before step 8) so every amount is the FINAL number that went to GHL. The
  // style id is stored once at the top level (every building/layout line shares it) and the
  // invoice-level discount as one synthetic entry, since it is not a line in targetItems.
  // Built BEFORE step 10 because the own-domain path's formal estimate PDF renders from this
  // same snapshot — the emailed document and the persisted books lines can never disagree.
  const estimateLines = {
    version: 1,
    styleId: styleRowId,
    discount: totalDiscount > 0 ? totalDiscount : 0,
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
            // estimate_lines.desc carries GHL-flavored HTML in two places (the floor-plan
            // <a> link prepended to the building line, and <br>-joined credit notes, both
            // entity-escaped). The PDF is plain text — de-render for it only: drop anchors
            // whole (a link label with no href is noise on paper), <br> → newline, strip
            // tags, then unescape in reverse of the escape order (&lt;/&gt; before &amp;).
            const deHtml = (s: string) =>
              s.replace(/<a\b[^>]*>[\s\S]*?<\/a>/gi, "")
                .replace(/<br\s*\/?>/gi, "\n")
                .replace(/<[^>]*>/g, "")
                .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&")
                .trim();
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

  await supabase
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

  return json({
    ok: true,
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
