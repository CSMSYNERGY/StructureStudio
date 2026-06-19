import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

// Beta routing: either the request body sets `betaMode: true` (staging deploys) or the
// client's settings row has beta_mode = true (per-tenant test switch). When active, the
// estimate-send step redirects the outbound email to the client's beta_email (or this
// QA inbox as a last resort) instead of the customer. Everything else (contact upsert,
// estimate create, opportunity link) still runs full-fidelity against the real GHL location.
const BETA_TEST_EMAIL = "beta@csmsynergy.com";

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

  const { designId, clientId, contact, selections, itemSummary, roughOpenings, customOptions, imageUrl, betaMode } = payload || {};

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
    .select("ghl_contact_id, ghl_estimate_id, ghl_estimate_number, ghl_opportunity_id")
    .eq("short_code", designId)
    .single();
  if (designErr || !existingDesign) {
    return json({ error: `Design ${designId} not found in Supabase` }, 404);
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

  // 4. Fetch GHL products
  let products: any[] = [];
  try {
    const r = await fetch(
      `https://services.leadconnectorhq.com/products/?locationId=${encodeURIComponent(locationId)}`,
      { headers: ghlHeaders }
    );
    if (!r.ok) return json({ error: `Failed to fetch products: ${r.status} ${await r.text()}` }, 502);
    const d = await r.json();
    products = d?.products || [];
  } catch (e) {
    return json({ error: `Products fetch error: ${(e as Error).message}` }, 502);
  }

  // 5. Fetch all prices, parallel
  const allPrices: any[] = [];
  await Promise.all(products.map(async (p: any) => {
    try {
      const r = await fetch(
        `https://services.leadconnectorhq.com/products/${p._id}/price?locationId=${encodeURIComponent(locationId)}`,
        { headers: ghlHeaders }
      );
      if (!r.ok) return;
      const d = await r.json();
      if (Array.isArray(d?.prices)) allPrices.push(...d.prices);
    } catch { /* ignore single-product failure */ }
  }));

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

  // 6. Product matching helper — ported from n8n verbatim
  function getProductDetails(searchString: string, userSelection = "") {
    if (!searchString || allPrices.length === 0) return null;
    const isNoVariant = (name: string) => name.split("@")[0].trim().toLowerCase().startsWith("no ");

    let matchedPrice = allPrices.find((p) => {
      if (!p.name) return false;
      if (isNoVariant(p.name)) return false;
      const cleanName = p.name.split("@")[0].trim().toLowerCase();
      return cleanName === searchString.toLowerCase();
    });

    if (!matchedPrice) {
      const searchTerms = searchString.toLowerCase().split(/\s+/);
      matchedPrice = allPrices.find((p) => {
        if (!p.name) return false;
        if (isNoVariant(p.name)) return false;
        const pName = p.name.toLowerCase();
        const isMatch = searchTerms.every((t) => pName.includes(t));
        if (isMatch) {
          if (/\bno\b/i.test(userSelection) && /\bno\b/i.test(pName)) return false;
          if (searchTerms.includes("paint") && !searchTerms.includes("unpaint") && pName.includes("unpaint")) return false;
        }
        return isMatch;
      });
    }

    if (matchedPrice) {
      const cleanName = matchedPrice.name.split(" @")[0].trim();
      const parentProduct = products.find((prod: any) => prod._id === matchedPrice.product);
      const itemImage = parentProduct ? (parentProduct.image || parentProduct.imageUrl || "") : "";
      return {
        name: cleanName,
        amount: matchedPrice.amount,
        priceId: matchedPrice._id,
        productId: matchedPrice.product,
        imageUrl: itemImage,
      };
    }
    return null;
  }

  // 7. Build line items
  const summary = itemSummary || {};
  const targetItems: any[] = [];

  const style = selections.buildingStyle || "";
  const size = selections.buildingSize || "";
  const paintStatus = (selections.paint && String(selections.paint).toLowerCase() === "painted") ? "Paint" : "Unpaint";

  // Building price: prefer a matching GHL product (unchanged for tenants like junior-barns
  // that price via GHL); when there's no GHL match (e.g. a tenant with no product catalog
  // who prices via the CSV), fall back to this tenant's CSV catalog price
  // (building_sizes.base_price, matched by style label + size label). Add-on options below
  // are still GHL-priced when products exist and $0 when they don't (getProductDetails
  // returns null with an empty price list) — so no-product tenants get "options free for now".
  const shed = getProductDetails(`${style} ${size} ${paintStatus}`);
  let csvBuildingPrice = 0;
  if (!shed) {
    try {
      // The designer submits the style's KEY (e.g. "test"), not its label ("Test"), and
      // sizes can render with a × vs x. Normalize both sides (lowercase, ×→x, strip spaces)
      // and match the style by key OR label so the CSV price reliably resolves.
      const norm = (s: unknown) => String(s ?? "").toLowerCase().replace(/[×✕]/g, "x").replace(/\s+/g, "");
      const stRes = await supabase.from("building_styles").select("id, key, label").eq("client_id", clientId);
      const styleRow = (stRes.data || []).find((r: any) => norm(r.key) === norm(style) || norm(r.label) === norm(style));
      if (styleRow) {
        const szRes = await supabase.from("building_sizes").select("base_price, label").eq("client_id", clientId).eq("style_id", styleRow.id);
        const sizeRow = (szRes.data || []).find((z: any) => norm(z.label) === norm(size));
        if (sizeRow && sizeRow.base_price != null) csvBuildingPrice = Number(sizeRow.base_price) || 0;
      }
    } catch { /* leave at 0 if the lookup fails */ }
  }
  targetItems.push({
    name: shed ? shed.name : `${style} (${size} - ${paintStatus})`,
    qty: 1,
    amount: shed ? shed.amount : csvBuildingPrice,
    priceId: shed?.priceId || "",
    productId: shed?.productId || "",
    attachments: shed?.imageUrl ? [shed.imageUrl] : [],
    currency: "USD",
    type: "one_time",
    description: `Size: ${size}` + (selections.paint ? ` | Paint: ${selections.paint}` : ""),
  });

  // GHL renders `description` as a subtitle under the line-item name. Pass "" when the
  // description would just repeat the name, otherwise it shows up redundantly on the PDF.
  const pushItem = (qty: number, search: string | string[], description: string) => {
    const searches = Array.isArray(search) ? search : [search];
    let pd: any = null;
    for (const s of searches) { pd = pd || getProductDetails(s); }
    targetItems.push({
      name: pd?.name || searches[0],
      qty,
      amount: pd?.amount || 0,
      priceId: pd?.priceId || "",
      productId: pd?.productId || "",
      attachments: pd?.imageUrl ? [pd.imageUrl] : [],
      currency: "USD",
      type: "one_time",
      description,
    });
  };

  if (summary.doubleDoors > 0) pushItem(summary.doubleDoors, "Double Door", "");
  if (summary.singleDoors > 0) pushItem(summary.singleDoors, "Single Door", "");
  if (summary.windows > 0) pushItem(summary.windows, "Window", "");

  if (Array.isArray(summary.workbenches) && summary.workbenches.length > 0) {
    summary.workbenches.forEach((wb: any) => {
      const lengthFt = wb.lengthFt || 1;
      const wall = wb.wall || "";
      const descParts: string[] = [];
      if (wall) descParts.push(`${wall} wall`);
      descParts.push(`${lengthFt}ft (priced per foot)`);
      pushItem(lengthFt, ["Workbench/Pegboard", "Workbench", "Pegboard", "Per Foot"], descParts.join(" - "));
    });
  }
  if (summary.lofts > 0) pushItem(summary.lofts, ["Loft", "Loft Kit", "Loft Storage"], "");
  if (summary.ramp && String(summary.ramp).toLowerCase() !== "no") pushItem(1, "Ramp", "");

  // Rough openings — webhook supplies name/dims/qty/amount directly, not from GHL products
  if (Array.isArray(roughOpenings)) {
    roughOpenings.forEach((ro: any) => {
      targetItems.push({
        name: ro.name || "Rough Opening",
        qty: ro.qty || 1,
        amount: typeof ro.amount === "number" ? ro.amount : 0,
        priceId: "",
        productId: "",
        attachments: [],
        currency: "USD",
        type: "one_time",
        description: ro.dimensions ? String(ro.dimensions) : "",
      });
    });
  }

  // Custom options — name doubles as the line title; leaving description blank keeps GHL
  // from rendering it as a duplicate subtitle.
  if (Array.isArray(customOptions)) {
    customOptions.filter((co: any) => co.name && String(co.name).trim()).forEach((co: any) => {
      targetItems.push({
        name: String(co.name).trim(),
        qty: co.qty ? Number(co.qty) || 1 : 1,
        amount: co.amount ? Number(co.amount) || 0 : 0,
        priceId: "",
        productId: "",
        attachments: [],
        currency: "USD",
        type: "one_time",
        description: "",
      });
    });
  }

  // 7b. Opportunity link/create. Pick the most-recently-updated opp for this contact and
  // refresh its name/value/stage; if it's won we leave it alone and create a new one
  // (won deals are closed shed sales — a fresh quote is a new pursuit). If it's lost we
  // update it back to status "open". Failures here are non-fatal — the estimate still
  // goes out.
  const oppName = `${style} ${size}`.trim();
  const oppValue = targetItems.reduce((s, it) => s + (Number(it.qty) || 0) * (Number(it.amount) || 0), 0);
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
  const estimateAttachments: any[] = [];
  if (imageUrl && !String(imageUrl).startsWith("data:")) {
    estimateAttachments.push({
      id: designId,
      name: `${designId}.pdf`,
      url: imageUrl,
      type: "application/pdf",
      size: 15000,
    });
  }

  const firstName = contact?.name ? String(contact.name).split(" ")[0] : "Customer";
  const estimateName = `${firstName} - ${style} ${size}`.trim();
  // Collision-resistant invoice sequence: low 8 digits of the epoch-ms clock
  // (unique within any ~28h window) + 2 random digits to cover two submissions
  // landing in the same millisecond. Replaces a plain 5-digit random, which by
  // the birthday bound collided after only a few hundred estimates.
  const uniqueSequence = (Date.now() % 100_000_000) * 100 + Math.floor(Math.random() * 100);

  const finalPayload: any = {
    altId: dynamicLocationId,
    userId: dynamicUserId,
    altType: "location",
    name: estimateName,
    title: "ESTIMATE",
    invoiceNumberPrefix: "EST-",
    estimateNumberPrefix: "EST-",
    invoiceNumber: uniqueSequence.toString(),
    currency: "USD",
    issueDate: today,
    expiryDate: expiryFormatted,
    terms: quoteTerms,
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
    discount: { value: 0, type: "percentage" },
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
  try {
    const url = existingEstimateId
      ? `https://services.leadconnectorhq.com/invoices/estimate/${existingEstimateId}`
      : `https://services.leadconnectorhq.com/invoices/estimate`;
    const method = existingEstimateId ? "PUT" : "POST";
    const r = await fetch(url, { method, headers: ghlHeaders, body: JSON.stringify(finalPayload) });
    if (!r.ok) {
      return json({ error: `Failed to ${existingEstimateId ? "update" : "create"} estimate: ${r.status} ${await r.text()}` }, 502);
    }
    const d = await r.json();
    estimateId = d?._id || d?.estimate?._id || existingEstimateId;
    estimateNumber = String(d?.estimateNumber ?? d?.estimate?.estimateNumber ?? d?.invoiceNumber ?? uniqueSequence);
  } catch (e) {
    return json({ error: `Estimate ${existingEstimateId ? "update" : "create"} error: ${(e as Error).message}` }, 502);
  }

  // 10. Send (re-emails on update, per requirements). In beta mode (request flag OR the
  //     client's beta_mode setting) the outbound email is redirected to the client's
  //     beta_email (falling back to the QA inbox) so test runs don't reach real customers.
  //     We capture the GHL response (status + body) and return it as `sendDebug` so
  //     failures don't hide behind a generic 200 — the React app or curl caller can
  //     inspect what GHL rejected.
  let sendDebug: { status: number | null; ok: boolean; body: string; sentTo: string[] } = {
    status: null,
    ok: false,
    body: "send step did not run",
    sentTo: [],
  };
  try {
    if (estimateId) {
      const recipients = effectiveBetaMode
        ? [settings.beta_email || BETA_TEST_EMAIL]
        : [contact?.email].filter(Boolean);
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
    sendDebug,
  });
});
