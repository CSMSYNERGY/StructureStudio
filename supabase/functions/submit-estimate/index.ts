import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

// The estimate email always goes to the customer — in every environment, beta included.
// `betaMode` (request flag or the client's beta_mode setting) is still surfaced for
// telemetry, but it no longer redirects the recipient: a previous QA-inbox redirect sent
// beta estimates to a non-deliverable address and they silently failed to send.

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...cors, "Content-Type": "application/json" },
  });
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  let payload: any;
  try { payload = await req.json(); }
  catch { return json({ error: "Invalid JSON" }, 400); }

  const { designId, clientId, contact, selections, itemSummary, roughOpenings, customOptions, imageUrl, betaMode, deliveryFee, declinedItems, discounts } = payload || {};

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
    .select("ghl_location_id, ghl_api_key, ghl_pipeline_id, ghl_stage_send_quote_id, business_name, business_phone, business_website, business_address, business_logo_url, quote_terms, beta_mode, beta_email")
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
    return json({
      error: `Can't create the estimate: the GHL location for "${clientId}" (${locationId}) has no user to assign it to. ` +
        `GHL requires a userId. Assign at least one user to that GHL sub-account (and ideally add a product for pricing), ` +
        `or set an explicit GHL user id in the client's settings, then resubmit.`,
    }, 400);
  }

  // 7. Build line items — every amount comes from this tenant's StructureStudio catalog
  //    (building_sizes for the building, layout_item_pricing for add-ons). GHL products are
  //    never consulted for pricing.
  const summary = itemSummary || {};
  const targetItems: any[] = [];

  // Per-line product image (the "image inside the app" the owner uploaded → shown on the
  // estimate line). Images live in this tenant's public 'branding' bucket; only attach a URL
  // under that tenant prefix so a tampered catalog row can't graft an arbitrary link onto the
  // branded estimate. GHL renders a line item's attachments as the product photo.
  const brandingPrefix = `${supabaseUrl}/storage/v1/object/public/branding/${clientId}/`;
  // GHL line-item attachments are an array of plain image-URL STRINGS (proven by the working
  // n8n payload: `attachments: [imageUrl]`). An array of objects is rejected. Only attach a
  // URL under this tenant's branding prefix so a tampered catalog row can't inject a link.
  const imgAttachments = (url: unknown): string[] => {
    const u = String(url || "");
    if (!u || !u.startsWith(brandingPrefix)) return [];
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
  targetItems.push(buildingLine);

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
      const incRes = await supabase.from("building_size_inclusions").select("item_key, qty").eq("size_id", sizeRowId).eq("included", true);
      for (const r of (incRes.data || []) as any[]) includedMap.set(String(r.item_key), Math.max(1, Number(r.qty) || 1));
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
      targetItems.push({
        name: `${searches[0]} (included)`, qty: placed, amount: 0,
        priceId: "", productId: "",
        attachments: lp ? imgAttachments(lp.imageUrl) : [],
        currency: "USD", type: "one_time",
        description: description || "Included with this size",
      });
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
    // description — total placed, included in the base price, and billable — matching the designer's
    // "N sq ft included" note. Appended if the caller already passed a description.
    let desc = description;
    if (includedQty > 0 && (method === "sqft_option" || method === "lineal_ft")) {
      const u = method === "sqft_option" ? "sq ft" : "ft";
      const breakdown = `${placed} ${u} placed · ${includedQty} ${u} included in base price · ${chargeable} ${u} billable @ $${(Number(rate) || 0).toFixed(2)}/${u}`;
      desc = desc ? `${desc} — ${breakdown}` : breakdown;
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
    targetItems.push(item);
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
    targetItems.push({
      name: "Paint Colors", qty: 1, amount: paintAmount, priceId: "", productId: "",
      attachments: [], currency: "USD", type: "one_time", description: paintDesc,
    });
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
    targetItems.push({
      name: "Roof", qty: 1, amount: roofAmount, priceId: "", productId: "",
      attachments: [], currency: "USD", type: "one_time", description: roofDesc,
    });
  }

  if (summary.doubleDoors > 0) pushItem("Double Door", "doubleDoor", "", { count: summary.doubleDoors });
  if (summary.singleDoors > 0) pushItem("Single Door", "singleDoor", "", { count: summary.singleDoors });
  if (summary.windows > 0) pushItem("Window", "window", "", { count: summary.windows });

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
  // Ramp is priced "each" — bill per ramp (one per door). Accept a numeric count from the
  // current frontend, or the legacy "yes"/"no" string from an older cached build.
  const rampCount = (() => {
    const v = summary.ramp;
    if (typeof v === "number") return v > 0 ? v : 0;
    const s = String(v ?? "").trim().toLowerCase();
    if (s === "yes") return 1;
    const n = parseInt(s, 10);
    return Number.isFinite(n) && n > 0 ? n : 0;
  })();
  if (rampCount > 0) pushItem("Ramp", "ramp", "", { count: rampCount });

  // Rough openings — priced from this tenant's layout_item_pricing "roughOpening" rate (each
  // owner can charge their own price; no hardcoded amount). One line per placed RO at that
  // rate, with the dimensions in the description. If no rate is configured, the line is $0.
  if (Array.isArray(roughOpenings)) {
    const roRate = layoutRates.get("roughOpening")?.rate || 0;
    roughOpenings.forEach((ro: any) => {
      targetItems.push({
        name: ro.name || "Rough Opening",
        qty: ro.qty || 1,
        amount: roRate,
        priceId: "",
        productId: "",
        attachments: [],
        currency: "USD",
        type: "one_time",
        description: ro.dimensions ? String(ro.dimensions) : "",
      });
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
      targetItems.push({
        name, qty, amount: rawAmt,
        priceId: "", productId: "", attachments: [],
        currency: "USD", type: "one_time", description: "",
      });
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
    for (const d of declinedItems) {
      const key = String(d?.key ?? "").trim();
      if (!key) continue;
      if (placedKeys.has(key)) continue;   // placed = kept, not a decline → no credit
      const lp = layoutRates.get(key);
      const rate = lp?.rate || 0;
      if (rate <= 0) continue;
      const method = lp?.method || "each";
      // Credit the included quantity for this size (shared includedMap; defaults to 1 for rows
      // imported before the quantity feature). pct_estimate_total can't be resolved before the
      // subtotal exists, so it keeps a flat credit — qty clamped to 1 so % isn't scaled by sq ft.
      const qty = method === "pct_estimate_total" ? 1 : (includedMap.get(key) ?? 1);
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
  // building line.
  if (Array.isArray(discounts)) {
    discounts.forEach((d: any) => {
      const amt = Math.round(Math.abs(Number(d?.amount) || 0) * 100) / 100;
      if (amt <= 0) return;
      discountTotal += amt;
      const desc = String(d?.description ?? "").trim();
      targetItems.push({
        name: desc ? `Discount — ${desc}` : "Discount",
        qty: 1, amount: 0, priceId: "", productId: "", attachments: [],
        currency: "USD", type: "one_time",
        description: `−$${amt.toFixed(2)} (applied as a discount below)`,
      });
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
  // Category IDs and Names" support doc. Amount is the designer's optional delivery-fee field;
  // omitted entirely when 0/blank.
  const deliveryAmt = Number(deliveryFee) || 0;
  if (deliveryAmt > 0) {
    targetItems.push({
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
    });
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
    if (!r.ok) {
      return json({ error: `Failed to ${existingEstimateId ? "update" : "create"} estimate: ${r.status} ${await r.text()}` }, 502);
    }
    const d = await r.json();
    estimateId = d?._id || d?.estimate?._id || existingEstimateId;
    estimateNumber = String(d?.estimateNumber ?? d?.estimate?.estimateNumber ?? d?.invoiceNumber ?? uniqueSequence);
  } catch (e) {
    return json({ error: `Estimate ${existingEstimateId ? "update" : "create"} error: ${(e as Error).message}` }, 502);
  }

  // 10. Send (re-emails on update, per requirements). The estimate email always goes to the
  //     customer's own email — beta deploys included. We capture the GHL response
  //     (status + body) and return it as `sendDebug` so failures don't hide behind a generic
  //     200 — the React app or curl caller can inspect what GHL rejected.
  let sendDebug: { status: number | null; ok: boolean; body: string; sentTo: string[] } = {
    status: null,
    ok: false,
    body: "send step did not run",
    sentTo: [],
  };
  try {
    if (estimateId) {
      const recipients = [contact?.email].filter(Boolean);
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
    } else {
      sendDebug.body = "no estimateId after create/update";
    }
  } catch (e) {
    sendDebug.body = `send threw: ${(e as Error).message}`;
    console.warn("Estimate send error:", (e as Error).message);
  }

  // 11. Persist GHL IDs
  await supabase
    .from("designs")
    .update({
      ghl_contact_id: contactId,
      ghl_estimate_id: estimateId,
      ghl_estimate_number: estimateNumber || existingDesign.ghl_estimate_number || null,
      ghl_opportunity_id: opportunityId || existingDesign.ghl_opportunity_id || null,
      updated_at: new Date().toISOString(),
    })
    .eq("short_code", designId);

  return json({
    ok: true,
    contactId,
    estimateId,
    estimateNumber: estimateNumber || existingDesign.ghl_estimate_number || null,
    opportunityId: opportunityId || existingDesign.ghl_opportunity_id || null,
    updated: Boolean(existingEstimateId),
    betaMode: effectiveBetaMode,
    lineImagesStripped,
    sendDebug,
  });
});
